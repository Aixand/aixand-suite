#!/usr/bin/env python3
"""Offline Codex protocol fixture, including streamed turns and approvals."""
import asyncio
import json
import os
import re
from pathlib import Path
import sys
import uuid
import traceback

home = Path(os.environ.get("TEST_AGENT_HOME") or os.environ.get("CODEX_HOME") or ".")
home.mkdir(parents=True, exist_ok=True)


async def captured_call(thread, server, name, arguments, *, expect_error=False):
    """Act as the offline model using the exact MCP endpoint captured by Codex."""
    descriptor = thread['config']['mcp_servers.' + server]
    process = await asyncio.create_subprocess_exec(
        descriptor['command'], *descriptor.get('args', []), cwd=thread['cwd'],
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, limit=1048576)
    sequence = 0
    async def request(method, params):
        nonlocal sequence
        sequence += 1
        process.stdin.write((json.dumps(dict(jsonrpc='2.0', id=sequence, method=method, params=params)) + '\n').encode())
        await process.stdin.drain()
        async with asyncio.timeout(30):
            while True:
                raw = await process.stdout.readline()
                if not raw:
                    raise RuntimeError('Captured MCP closed: ' + (await process.stderr.read()).decode())
                reply = json.loads(raw)
                if reply.get('id') == sequence:
                    assert 'error' not in reply, reply
                    return reply['result']
    try:
        await request('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'offline-codex', 'version': '1'}})
        process.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        await process.stdin.drain()
        listing = await request('tools/list', {})
        assert name in {tool['name'] for tool in listing['tools']}, listing
        result = await request('tools/call', {'name': name, 'arguments': arguments})
        assert bool(result.get('isError')) == expect_error, result
        content = result.get('structuredContent')
        if content is None:
            content = json.loads(next(item['text'] for item in result['content'] if item['type'] == 'text'))
        thread.setdefault('mcpCalls', []).append({'server': server, 'name': name, 'arguments': arguments, 'result': content, 'expectedError': expect_error})
        return content
    finally:
        process.stdin.close()
        try:
            async with asyncio.timeout(5):
                await process.wait()
        except TimeoutError:
            process.kill()
            await process.wait()


async def serve(path):
    saved_threads = home / 'fixture-threads.json'
    threads = json.loads(saved_threads.read_text()) if saved_threads.exists() else {}
    owned_threads = set()
    tasks = {}
    connections = set()
    approvals = {}
    pending_requests = {}

    async def send_request(identifier, method, params):
        request = {"id": identifier, "method": method, "params": params}
        pending_requests[identifier] = request
        for socket in list(connections):
            try:
                await socket.send(json.dumps(request))
            except Exception:
                pass

    async def tool_call(thread_id, turn_id, name, arguments, call_id, namespace="aixand_workspace"):
        identifier = "tool-" + uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        approvals[identifier] = future
        item = {"id": call_id, "type": "dynamicToolCall", "tool": name,
                "arguments": arguments, "status": "inProgress", "contentItems": []}
        turn_value = next(value for value in threads[thread_id]["turns"] if value["id"] == turn_id)
        if not any(existing["id"] == call_id for existing in turn_value["items"]):
            turn_value["items"].append(item)
        await broadcast("item/started", {"threadId": thread_id, "turnId": turn_id, "item": item})
        await send_request(identifier, "item/tool/call", {
            "threadId": thread_id, "turnId": turn_id, "callId": call_id,
            "namespace": namespace, "tool": name, "arguments": arguments})
        result = await future
        item.update(status="completed" if result["success"] else "failed", contentItems=result["contentItems"])
        save()
        await broadcast("item/completed", {"threadId": thread_id, "turnId": turn_id, "item": item})
        await broadcast("serverRequest/resolved", {"threadId": thread_id, "requestId": identifier})
        return json.loads(result["contentItems"][0]["text"])

    def save():
        # Separate captured executions can have independent native homes. Keep
        # browser evidence per thread, without concurrent whole-file overwrites.
        evidence_config = Path(__file__).with_name('offline-provider-evidence.json')
        if evidence_config.exists():
            registry = Path(json.loads(evidence_config.read_text())['directory'])
            registry.mkdir(parents=True, exist_ok=True)
            auth = (home / 'auth.json').read_text() if (home / 'auth.json').exists() else ''
            for key in owned_threads:
                thread = threads[key]
                thread['fixtureProfile'] = auth.removeprefix('offline-fixture-private-token:')
                thread['fixtureHome'] = str(home)
                pending = registry / (key + '.' + str(os.getpid()) + '.pending')
                pending.write_text(json.dumps(thread))
                pending.replace(registry / (key + '.json'))
        sessions = home / 'sessions'
        sessions.mkdir(exist_ok=True)
        for thread in threads.values():
            path = sessions / ('rollout-' + thread['id'] + '.jsonl')
            thread['path'] = str(path)
            rows = [{'type': 'session_meta', 'payload': {'id': thread['id'], 'cwd': thread['cwd']}}]
            for turn in thread['turns']:
                for item in turn['items']:
                    if item['type'] == 'userMessage':
                        rows.append({'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': item['content']}})
                    elif item['type'] == 'agentMessage':
                        rows.append({'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': item['text']}]}})
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        pending = home / 'fixture-threads.pending'
        pending.write_text(json.dumps(threads))
        pending.replace(saved_threads)

    async def broadcast(method, params):
        if method == "serverRequest/resolved":
            pending_requests.pop(params["requestId"], None)
        elif method == "turn/completed":
            for identifier, request in list(pending_requests.items()):
                if request["params"].get("threadId") == params["threadId"]:
                    pending_requests.pop(identifier, None)
        for socket in list(connections):
            try:
                await socket.send(json.dumps({"method": method, "params": params}))
            except Exception:
                pass

    async def architecture_continuation(thread_id, value, context):
        """Scripted offline model: exercise real tools and durable result wakeups."""
        monitor = context['monitorId']
        memory = json.loads(context['memory']) if context.get('memory') else {}
        state, evidence = 'waiting', []
        stage = memory.get('stage', 'audit')
        if stage == 'audit':
            projects = await tool_call(thread_id, value['id'], 'list_projects', {'query': 'Undercurrent'}, 'architecture-projects-' + value['id'])
            memory['projectId'] = projects['projects'][0]['id']
            audit = await tool_call(thread_id, value['id'], 'start_project_chat', {
                'projectId': memory['projectId'], 'title': 'Undercurrent architecture auditor',
                'instruction': 'slow architecture audit fixture'}, 'architecture-audit-' + value['id'])
            memory.update(stage='verify', auditor=audit['chatId'], awaiting=audit['id'])
            progress = 'Waiting for the architecture auditor.'
        else:
            kind = 'receipt' if stage == 'deliver' else 'delegation'
            observation = next(row for row in context['observations'] if row['kind'] == kind and row['targetId'] == memory['awaiting'])
            chunks, offset = [], 0
            while True:
                page = await tool_call(thread_id, value['id'], 'read_monitor_evidence', {
                    'monitorId': monitor, 'evidenceId': observation['evidenceId'], 'offset': offset}, 'architecture-report-' + value['id'] + '-' + str(offset))
                chunks.append(page['text'])
                if page['nextOffset'] is None:
                    break
                offset = page['nextOffset']
            report = ''.join(chunks)
            if stage == 'verify':
                verifier = await tool_call(thread_id, value['id'], 'start_project_chat', {
                    'projectId': memory['projectId'], 'title': 'Independent architecture verifier',
                    'instruction': 'slow architecture verifier fixture'}, 'architecture-verify-' + value['id'])
                memory.update(stage='brief', awaiting=verifier['id'])
                progress = 'Waiting for independent verification.'
            elif stage == 'brief':
                assert 'confirmed' in report.lower(), report
                receipt = await tool_call(thread_id, value['id'], 'send_chat_message', {
                    'chatId': memory['auditor'], 'text': 'slow architecture brief fixture'}, 'architecture-brief-' + value['id'], 'aixand_conversations')
                assert receipt.get('completionWatch'), receipt
                memory.update(stage='deliver', awaiting=receipt['messageId'])
                progress = 'Waiting for the original auditor to return its brief.'
            else:
                try:
                    report = json.loads(report)['report']
                except (ValueError, KeyError, TypeError):
                    pass
                state, evidence = 'completed', [observation['evidenceId']]
                memory.update(stage='done')
                progress = report
        await tool_call(thread_id, value['id'], 'checkpoint_monitor', {'monitorId': monitor, 'state': state,
            'progress': progress, 'memory': json.dumps(memory), 'evidence': evidence}, 'architecture-checkpoint-' + value['id'])

    async def turn(thread_id, value, prompt):
        try:
            user = {"id": "user-" + value["id"], "type": "userMessage", "content": [{"type": "text", "text": prompt}]}
            value["items"].append(user)
            save()
            await broadcast("item/started", {"threadId": thread_id, "turnId": value["id"], "item": user})
            if prompt.lower().startswith('i want you to spawn a chat for undercurrent'):
                projects = await tool_call(thread_id, value['id'], 'list_projects', {'query': 'Undercurrent'}, 'architecture-source-project-' + value['id'])
                await tool_call(thread_id, value['id'], 'create_monitor', {'title': 'Undercurrent architecture review',
                    'instruction': prompt, 'projectId': projects['projects'][0]['id']}, 'architecture-create-' + value['id'])
                prompt = 'I will audit the architecture, independently verify it, and return the original auditor’s brief as results arrive.'
            if prompt.startswith('supervise checkout '):
                link = re.search(r'#/chat/([a-f0-9-]{36})', prompt)
                watched = link.group(1) if link else prompt.rsplit(' ', 1)[1]
                await tool_call(thread_id, value['id'], 'create_monitor', {
                    'title': 'Finish checkout', 'instruction': 'Complete checkout requirements, then independently audit the implementation.',
                    'permissionMode': 'read-only', 'watches': [{'kind': 'chat', 'targetId': watched}],
                }, 'create-monitor-' + value['id'])
                prompt = 'I will supervise checkout and verify it with an independent audit.'
            if '"executionId":' in prompt and '"title": "Undercurrent architecture review"' in prompt:
                context = json.loads(prompt[prompt.rfind('\n\n{') + 2:])
                await architecture_continuation(thread_id, value, context)
                prompt = 'Architecture supervision checkpoint saved'
            if '"executionId":' in prompt and 'persistent autonomous monitor' in prompt:
                context = json.loads(prompt[prompt.rfind('\n\n{') + 2:])
                monitor_id = context['monitorId']
                memory = context.get('memory', '')
                watched = next(row['targetId'] for row in context['watches'] if row['kind'] == 'chat')
                state, evidence, watches = 'waiting', [], []
                if not memory:
                    receipt = await tool_call(thread_id, value['id'], 'send_chat_message', {
                        'chatId': watched, 'text': 'slow command checkout implementation'}, 'command-send-' + value['id'], 'aixand_conversations')
                    watches = [{'kind': 'receipt', 'targetId': receipt['messageId']}]
                    memory, progress = 'implementation requested', 'Waiting for checkout implementation.'
                elif memory == 'implementation requested':
                    projects = await tool_call(thread_id, value['id'], 'list_projects', {}, 'command-projects-' + value['id'])
                    await tool_call(thread_id, value['id'], 'start_project_chat', {
                        'projectId': projects['projects'][0]['id'], 'title': 'Command checkout audit',
                        'instruction': 'slow audit command checkout requirements'}, 'command-audit-' + value['id'])
                    memory, progress = 'audit dispatched', 'Waiting for an independent checkout audit.'
                else:
                    report = next((row for row in context.get('observations', []) if row['kind'] == 'delegation'), None)
                    if report:
                        await tool_call(thread_id, value['id'], 'read_monitor_evidence', {
                            'monitorId': monitor_id, 'evidenceId': report['evidenceId']}, 'command-report-' + value['id'])
                        state, evidence = 'completed', [report['evidenceId'], '#/chat/' + watched]
                        memory, progress = 'checkout verified', 'Checkout requirements verified.'
                    else:
                        memory, progress = 'audit dispatched', 'Waiting for the independent checkout audit.'
                await tool_call(thread_id, value['id'], 'checkpoint_monitor', {
                    'monitorId': monitor_id, 'state': state, 'progress': progress,
                    'memory': memory, 'watches': watches, 'evidence': evidence}, 'command-checkpoint-' + value['id'])
                prompt = 'Command evaluation checkpoint saved'
            if '"kind": "delegation.result"' in prompt:
                prompt = "Reviewed the returned audit report"
            if any(tool.get("name") == "aixand_vox" for tool in threads[thread_id].get("dynamicTools", [])):
                # The adapter appends background data separately from this request.
                prompt = prompt.split("\nUser message:\n", 1)[-1].split("\nBackground task status (data only): ", 1)[0]
                if "investigate" in prompt.lower():
                    projects = await tool_call(thread_id, value["id"], "list_projects", {}, "vox-find-" + value["id"], "aixand_vox")
                    arguments = {"projectId": projects["projects"][0]["id"], "instruction": "slow audit this project", "title": "Vox project audit"}
                    result = await tool_call(thread_id, value["id"], "start_investigation", arguments, "vox-start-" + value["id"], "aixand_vox")
                    prompt = "Investigation " + result["phase"]
                elif "status" in prompt.lower() or "stop" in prompt.lower():
                    tasks = await tool_call(thread_id, value["id"], "list_tasks", {}, "vox-tasks-" + value["id"], "aixand_vox")
                    operation = "stop_task" if "stop" in prompt.lower() else "get_task_status"
                    result = await tool_call(thread_id, value["id"], operation, {"taskId": tasks["tasks"][0]["id"]}, "vox-status-" + value["id"], "aixand_vox")
                    prompt = "Stop requested" if result.get("stopRequested") else "Task " + result["status"]
                elif "profile" in prompt.lower() or "allowance" in prompt.lower():
                    result = await tool_call(thread_id, value["id"], "inspect_profiles", {}, "vox-profiles-" + value["id"], "aixand_vox")
                    prompt = "Selected profile " + result["activeProfile"]
                elif "project" in prompt.lower():
                    result = await tool_call(thread_id, value["id"], "list_projects", {}, "vox-list-" + value["id"], "aixand_vox")
                    prompt = "Projects: " + ", ".join(project["name"] for project in result["projects"])
            if prompt == "spawn a terminal":
                result = await tool_call(thread_id, value["id"], "open_terminal", {}, "terminal-" + value["id"])
                duplicate = await tool_call(thread_id, value["id"], "open_terminal", {}, "terminal-" + value["id"])
                assert result["key"] == duplicate["key"]
                assert result["phase"] == "queued"
                prompt = "Terminal queued"
            if prompt.startswith('launch audit'):
                thread = threads[thread_id]
                instructions = thread.get('developerInstructions') or ''
                provider = re.search(r'Provider: ([^.]+)', instructions).group(1)
                environment = re.search(r'Environment: ([^.]+)', instructions).group(1)
                args = dict(provider=provider, environment_id=environment, cwd=thread['cwd'],
                            instruction='slow audit authentication', operation_id='audit-' + value['id'])
                result = await captured_call(thread, 'agent_manager_suite_tools', 'delegate_conversation_task', args)
                duplicate = await captured_call(thread, 'agent_manager_suite_tools', 'delegate_conversation_task', args)
                assert result == duplicate, (result, duplicate)
                assert result['status'] == 'completed', result
                rejection = await captured_call(thread, 'agent_manager_suite_tools', 'delegate_conversation_task',
                    {**args, 'operation_id': 'unsupported-detached-' + value['id'], 'detached': True}, expect_error=True)
                assert rejection['error']['code'] == 'validation', rejection
                thread['auditTask'] = result['result']['task_id']
                save()
                prompt = 'slow parent audit launched' if 'slow parent' in prompt else 'Audit launched'
            if prompt == 'inspect audit result':
                thread = threads[thread_id]
                result = await captured_call(thread, 'agent_manager_suite_tools', 'get_delegated_task', {'task_id': thread['auditTask']})
                assert result['status'] == 'completed', result
                assert result['result']['outcome'] == 'completed', result
                assert result['result']['report'] == 'Offline authentication audit completed', result
                save()
                prompt = 'Canonical audit report accepted'
            if prompt == "write scratch file":
                (Path(threads[thread_id]["cwd"]) / "scratch-note.txt").write_text("A file generated in this chat's workspace.")
                prompt = "Saved scratch-note.txt"
            if "approve" in prompt:
                identifier = len(approvals) + 100
                future = asyncio.get_running_loop().create_future()
                approvals[identifier] = future
                await send_request(identifier, "item/commandExecution/requestApproval", {
                    "threadId": thread_id, "turnId": value["id"], "itemId": "cmd-1", "command": "echo approved", "reason": "Fixture command approval"})
                decision = await future
                await broadcast("serverRequest/resolved", {"threadId": thread_id, "requestId": identifier})
                prompt = "approved" if decision.get("decision") == "accept" else "denied"
            if "question" in prompt:
                identifier = len(approvals) + 200
                future = asyncio.get_running_loop().create_future()
                approvals[identifier] = future
                await send_request(identifier, "item/tool/requestUserInput", {
                    "threadId": thread_id, "turnId": value["id"], "itemId": "question-1", "questions": [
                        {"id": "choice", "header": "Choice", "question": "Which option should I use?", "options": [{"label": "First", "description": "The first option"}]}]})
                answer = await future
                await broadcast("serverRequest/resolved", {"threadId": thread_id, "requestId": identifier})
                prompt = answer["answers"]["choice"]["answers"][0]
            if "slow" in prompt:
                await asyncio.sleep(8 if 'mcp_servers.agent_manager_task_result' in threads[thread_id].get('config', {}) else 3)
            prompt = {
                'slow architecture audit fixture': 'Architecture audit: transport and policy have separate owners.',
                'slow architecture verifier fixture': 'Confirmed: the architecture claims match the independent review.',
                'slow architecture brief fixture': 'Architecture brief: transport and policy have separate owners.',
            }.get(prompt, prompt)
            if value.get("steering"):
                prompt += " · context: " + " | ".join(value["steering"])
            item = {"id": "answer-" + value["id"], "type": "agentMessage", "text": ""}
            value["items"].append(item)
            await broadcast("item/started", {"threadId": thread_id, "turnId": value["id"], "item": item})
            interruption_probe = prompt == "Vox interruption probe"
            chunks = ["This reply should stop when you speak. "] * 40 if interruption_probe else ["Reply: ", prompt, " · done"]
            if "final answer MUST be a JSON object" in (threads[thread_id].get("developerInstructions") or ""):
                chunks = [json.dumps({"outcome": "completed", "report": "Reply: " + prompt + " · done"})]
            for chunk in chunks:
                item["text"] += chunk
                save()
                await broadcast("item/agentMessage/delta", {"threadId": thread_id, "turnId": value["id"], "itemId": item["id"], "delta": chunk})
                await asyncio.sleep(.75 if interruption_probe else 1 if prompt == "streaming probe" else .1)
            await broadcast("item/completed", {"threadId": thread_id, "turnId": value["id"], "item": item})
            if 'mcp_servers.agent_manager_task_result' in threads[thread_id].get('config', {}) and not threads[thread_id].get('reported'):
                await captured_call(threads[thread_id], 'agent_manager_task_result', 'submit_task_result', {
                    'operation_id': 'offline-audit-report', 'outcome': 'completed', 'report': 'Offline authentication audit completed'})
                threads[thread_id]['reported'] = True
            value["status"] = "completed"
        except Exception:
            with (home / 'fixture-errors.log').open('a') as output:
                traceback.print_exc(file=output)
            raise
        except asyncio.CancelledError:
            value["status"] = "interrupted"
            if prompt == "Vox interruption probe":
                # Exercise an acknowledged interrupt followed by stale output
                # and delayed terminal confirmation, like an in-flight stream.
                await broadcast("item/agentMessage/delta", {"threadId": thread_id,
                    "turnId": value["id"], "itemId": "answer-" + value["id"], "delta": "OBSOLETE VOX OUTPUT"})
                await asyncio.sleep(.6)
        finally:
            save()
            await broadcast("turn/completed", {"threadId": thread_id, "turn": value})

    async def handler(socket):
        connections.add(socket)
        try:
            async for raw in socket:
                message = json.loads(raw)
                if "method" not in message:
                    future = approvals.get(message.get("id"))
                    if future is not None and not future.done():
                        future.set_result(message.get("result", {}))
                    continue
                method, args = message["method"], message.get("params") or {}
                result = {}
                if method == 'initialize':
                    result = {'serverInfo': {'version': '0.166.0'}}
                elif method == 'config/read':
                    result = {'config': {}, 'origins': {}}
                elif method in ('permissionProfile/list', 'collaborationMode/list', 'mcpServerStatus/list'):
                    result = {'data': []}
                elif method == 'skills/list':
                    result = {'data': []}
                elif method == 'thread/loaded/list':
                    result = {'data': list(threads)}
                elif method == 'account/rateLimits/read':
                    budgets_file = home.parent / 'fixture-budgets.json'
                    budgets = json.loads(budgets_file.read_text()) if budgets_file.exists() else {}
                    auth = (home / 'auth.json').read_text() if (home / 'auth.json').exists() else ''
                    result = {'rateLimits': {'secondary': {'usedPercent': budgets.get(auth, 25),
                        'windowDurationMins': 10080, 'resetsAt': 1800000000}}}
                elif method == 'account/read':
                    result = {'account': {'type': 'apiKey'}, 'requiresOpenaiAuth': False}
                elif method == "model/list":
                    result = {"data": [
                        {"id": "catalog-fast", "model": "fixture-fast", "displayName": "Fixture Fast", "description": "Quick replies", "hidden": False, "isDefault": True, "defaultReasoningEffort": "medium", "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]},
                        {"id": "catalog-deep", "model": "fixture-deep", "displayName": "Fixture Deep", "description": "Detailed work", "hidden": False, "isDefault": False, "defaultReasoningEffort": "medium", "supportedReasoningEfforts": [{"reasoningEffort": "medium"}, {"reasoningEffort": "high"}]},
                    ], "nextCursor": None}
                elif method == "thread/start":
                    identifier = str(uuid.uuid4())
                    owned_threads.add(identifier)
                    threads[identifier] = {"id": identifier, "cwd": args["cwd"], "sandbox": args.get("sandbox"),
                        "approvalPolicy": args.get("approvalPolicy"), "model": args.get("model", "fixture-fast"), "turns": [], "status": {"type": "idle"},
                        "config": args.get("config", {}), "dynamicTools": args.get("dynamicTools", []), "developerInstructions": args.get("developerInstructions")}
                    result = {"thread": threads[identifier], "model": threads[identifier]["model"], "cwd": args["cwd"], "effort": "medium"}
                    save()
                elif method in ("thread/resume", "thread/read"):
                    if method == "thread/resume":
                        owned_threads.add(args["threadId"])
                    if method == "thread/resume" and "model" in args:
                        threads[args["threadId"]]["model"] = args["model"]
                        save()
                    if method == "thread/resume" and "sandbox" in args:
                        threads[args["threadId"]]["sandbox"] = args["sandbox"]
                        save()
                    # Match native Codex: resume restores saved dynamic tools;
                    # supplying dynamicTools here does not replace the schema.
                    result = {"thread": threads[args["threadId"]]}
                    if method == "thread/resume":
                        for request in list(pending_requests.values()):
                            if request["params"].get("threadId") == args["threadId"]:
                                await socket.send(json.dumps(request))
                elif method == "turn/start":
                    identifier = args["threadId"]
                    value = {"id": uuid.uuid4().hex, "status": "inProgress", "items": [], "error": None}
                    threads[identifier]["turns"].append(value)
                    save()
                    # Exercise notification-before-response ordering.
                    await broadcast("turn/started", {"threadId": identifier, "turn": value})
                    result = {"turn": value}
                    tasks[identifier] = asyncio.create_task(turn(identifier, value, args["input"][0]["text"]))
                elif method == "turn/steer":
                    identifier = args["threadId"]
                    value = threads[identifier]["turns"][-1]
                    if value["status"] != "inProgress" or value["id"] != args["expectedTurnId"]:
                        await socket.send(json.dumps({"id": message["id"], "error": {"code": -32000, "message": "No matching active turn"}}))
                        continue
                    text = args["input"][0]["text"]
                    value.setdefault("steering", []).append(text)
                    item = {"id": "steer-" + uuid.uuid4().hex, "type": "userMessage", "content": [{"type": "text", "text": text}]}
                    value["items"].append(item)
                    save()
                    await broadcast("item/completed", {"threadId": identifier, "turnId": value["id"], "item": item})
                    result = {"turnId": value["id"]}
                elif method == "turn/interrupt":
                    task = tasks.get(args["threadId"])
                    if task:
                        task.cancel()
                elif method == "initialized":
                    continue
                else:
                    if 'id' in message:
                        await socket.send(json.dumps({'id': message['id'], 'error': {
                            'code': -32601, 'message': 'Unsupported fixture method: ' + method}}))
                    continue
                if "id" in message:
                    await socket.send(json.dumps({"id": message["id"], "result": result}))
        finally:
            connections.discard(socket)

    if path == 'stdio://':
        class StdioSocket:
            def __aiter__(self):
                return self

            async def __anext__(self):
                line = await asyncio.to_thread(sys.stdin.readline)
                if not line:
                    raise StopAsyncIteration
                return line

            async def send(self, value):
                print(value, flush=True)

        await handler(StdioSocket())
    else:
        from websockets.asyncio.server import unix_serve
        async with unix_serve(handler, path, compression=None):
            await asyncio.Future()


async def terminal_client(thread_id, endpoint):
    """Minimal native client stand-in; real Codex is verified separately."""
    from websockets.asyncio.client import unix_connect

    async with unix_connect(endpoint.removeprefix("unix://")) as socket:
        pending = {}
        sequence = 0

        async def receive():
            async for raw in socket:
                message = json.loads(raw)
                if "method" not in message and message.get("id") in pending:
                    pending.pop(message["id"]).set_result(message["result"])
                elif message.get("method") == "item/agentMessage/delta" and message["params"].get("threadId") == thread_id:
                    print(message["params"]["delta"], end="", flush=True)
                elif message.get("method") == "turn/completed" and message["params"].get("threadId") == thread_id:
                    print("\n> ", end="", flush=True)

        async def request(method, params):
            nonlocal sequence
            sequence += 1
            future = asyncio.get_running_loop().create_future()
            pending[sequence] = future
            await socket.send(json.dumps({"id": sequence, "method": method, "params": params}))
            return await future

        reader = asyncio.create_task(receive())
        try:
            await request("initialize", {"clientInfo": {"name": "fixture_terminal", "version": "1"}})
            await socket.send(json.dumps({"method": "initialized"}))
            result = await request("thread/resume", {"threadId": thread_id})
            print("Resumed thread " + thread_id, flush=True)
            for turn_value in result["thread"]["turns"]:
                for item in turn_value["items"]:
                    if item.get("text"):
                        print(item["text"], flush=True)
            print("> ", end="", flush=True)
            while line := await asyncio.to_thread(sys.stdin.readline):
                await request("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": line.strip()}]})
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)


if __name__ == "__main__":
    if '--version' in sys.argv:
        print('codex 0.166.0')
    elif "login" in sys.argv:
        if 'status' in sys.argv:
            if not (home / 'auth.json').exists():
                print('Not logged in', flush=True)
                sys.exit(1)
            print('Logged in with fixture native account', flush=True)
        else:
            (home / "auth.json").write_text("fixture-private-login")
    elif "--listen" in sys.argv:
        endpoint = sys.argv[sys.argv.index("--listen") + 1]
        asyncio.run(serve(endpoint.removeprefix("unix://")))
    elif "--remote" in sys.argv:
        asyncio.run(terminal_client(sys.argv[sys.argv.index("resume") + 1], sys.argv[sys.argv.index("--remote") + 1]))
    else:
        for line in sys.stdin:
            message = json.loads(line)
            if "id" in message:
                budget_file = home.parent / "fixture-budgets.json"
                budgets = json.loads(budget_file.read_text()) if budget_file.exists() else {}
                auth = (home / "auth.json").read_text() if (home / "auth.json").exists() else ""
                used = budgets.get(auth, 25)
                result = {"rateLimits": {"secondary": {"usedPercent": used, "windowDurationMins": 10080}}} if message["method"] == "account/rateLimits/read" else {}
                if message['method'] == 'account/read':
                    result = {'account': {'type': 'apiKey'}, 'requiresOpenaiAuth': False}
                print(json.dumps({"id": message["id"], "result": result}), flush=True)
