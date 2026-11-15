"""Workflow views and controls through Runner's public client."""
import asyncio
from copy import deepcopy
import json
import os

from conversation_manager import ConversationError
from orchestration_mcp.optional import available, require


class SuiteWorkflows:
    def __init__(self, chats, *, runner_factory=None):
        self.chats = chats
        self.runner_factory = runner_factory

    def runner(self):
        return (self.runner_factory or require('runner').Client)(
            home=getattr(self.chats.adapter, 'runner_home', None) or os.environ.get('WORKFLOW_RUNNER_HOME') or os.environ.get('RUNNER_HOME'), timeout=2)

    def records(self):
        rows = []
        for db, table, column in ((self.chats.db, 'native_runs', 'record'),
                (self.chats.executions.db, 'execution_workflows', 'body')):
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                for entry in db.execute(f'SELECT {column} FROM {table} ORDER BY rowid DESC'):
                    row = json.loads(entry[0])
                    if table == 'execution_workflows':
                        found = self.chats.db.execute("SELECT chat_id FROM suite_tool_refs WHERE kind='workflow' AND id=?", (row['workflow_id'],)).fetchone()
                        row['originChatId'] = found[0] if found else ''
                        row['key'] = row['workflow_id']
                        row['id'] = row.get('runner_job_id') or (row.get('runner_submission') or {}).get('job', {}).get('id')
                    rows.append(row)
        return rows

    def view(self, record, job=None, plan=None):
        record, job, plan = record or {}, job or {}, plan or {}
        submission = job.get('submission') or record.get('submission') or {}
        workflow = plan.get('workflow') or record.get('plan') or submission.get('workflow') or {}
        if 'workflow' in workflow and not workflow.get('format'):
            workflow = workflow['workflow']
        metadata = submission.get('metadata') or {}
        context = workflow.get('context') or {}
        identifier = job.get('id') or record.get('id')
        key = record.get('key') or submission.get('key') or identifier
        origin = record.get('originChatId') or context.get('originChatId') or ''
        project_id = record.get('projectId') or workflow.get('project_id') or context.get('projectId') or ''
        project = self.chats.projects.find(project_id) if project_id else None
        states = plan.get('operations') or {}
        result = record.get('result') or job.get('result') or {}
        observed = result.get('steps') or {}
        definitions = workflow.get('steps') or []
        canvas = plan.get('authoring')
        if workflow.get('format') == 'aixand.workflow-graph':
            operations = workflow.get('workflow', {}).get('body', {}).get('steps', [])
            groups = workflow.get('groups') or {item['id']: [item['id']] for item in operations}
            labels = {node['id']: node.get('data', {}).get('label', node['id']) for node in (canvas or {}).get('nodes', [])}
            owners = {member: group for group, members in groups.items() for member in members}
            dependencies = workflow.get('dependencies') or {}
            definitions = [dict(id=group, title=labels.get(group, group), members=members,
                depends_on=sorted({owners[dependency] for member in members for dependency in dependencies.get(member, [])
                    if dependency in owners and owners[dependency] != group})) for group, members in groups.items()]
        steps = []
        for step in definitions:
            members = step.get('members', [step['id']])
            values = [observed.get(member, {}).get('state') or states.get(member, 'pending') for member in members]
            state = 'completed' if values and all(value == 'completed' for value in values) else 'failed' if 'failed' in values else 'running' if any(value in ('claimed', 'running', 'starting') for value in values) else 'uncertain' if 'uncertain' in values else 'pending'
            steps.append(dict(id=step['id'], title=step.get('title', step['id']), dependsOn=step.get('depends_on', []), state=state))
        error = job.get('error') or record.get('error')
        return dict(key=key, id=identifier, originChatId=origin, projectId=project_id,
            project=record.get('project') or (project['name'] if project else 'Workflow'),
            title=record.get('title') or workflow.get('name', 'Workflow'), state=job.get('state') or record.get('state', 'uncertain'),
            createdAt=job.get('created_at', record.get('createdAt', 0)), updatedAt=job.get('updated_at', record.get('updatedAt', 0)),
            revision=plan.get('status_sequence', record.get('revision', 0)), planRevision=plan.get('revision'),
            held=plan.get('held', False), phase=plan.get('phase'), lockedGroups=plan.get('locked_groups', []),
            steps=steps, executionWorkflow=deepcopy(workflow), canvas=deepcopy(canvas), namespace=metadata.get('suite_namespace', key),
            workflowId=metadata.get('workflowId'), parentJobId=metadata.get('parent_job_id'),
            accepted=bool(identifier), url='#/workflows/runs/' + str(identifier or key), deliveryStep=workflow.get('delivery_step'),
            delivery=record.get('delivery') or result.get('delivery'), error=error.get('message') if isinstance(error, dict) else error)

    async def listing(self, offset=0, limit=20):
        records = self.records()
        if not self.runner_factory and not available('runner'):
            return self.saved_page(records, offset, limit)
        pending = [row for row in records if not row.get('id')]
        selected = [self.view(row) for row in pending[offset:offset + limit]] if offset < len(pending) else []
        try:
            runner = self.runner()
            after = max(0, offset - len(pending))
            jobs = await asyncio.to_thread(runner.list, after=after, limit=limit - len(selected) + 1)
            count = limit - len(selected)
            for summary in jobs[:count]:
                job = await asyncio.to_thread(runner.inspect, summary['id'])
                plan = await asyncio.to_thread(runner.plan, summary['id'])
                row = next((row for row in records if row.get('id') == job['id'] or row.get('runner_key') == job['submission']['key']), None)
                selected.append(self.view(row, job, plan))
            more = len(jobs) > count or offset + len(selected) < len(pending)
            cursor = len(pending) + jobs[:count][-1]['sequence'] if count and jobs[:count] else offset + len(selected)
            return dict(runs=selected, nextOffset=cursor if more else None, runnerAvailable=True)
        except (OSError, RuntimeError, ValueError) as error:
            return self.saved_page(records, offset, limit, error='Runner is unavailable. Showing saved workflow records.')

    def saved_page(self, records, offset, limit, error=''):
        return dict(runs=[self.view(row) for row in records[offset:offset + limit]],
            nextOffset=offset + limit if len(records) > offset + limit else None, runnerAvailable=False, error=error)

    async def open(self, identifier, *, origin=None, action='status'):
        records = self.records()
        row = next((row for row in records if identifier in (row.get('id'), row.get('key'), row.get('runner_key'))), None)
        if origin and row and row.get('originChatId') != origin:
            raise ConversationError('unauthorized', 'This workflow does not belong to the selected conversation.')
        try:
            runner = self.runner()
            job = await asyncio.to_thread(runner.lookup, row.get('runner_key') or row['key']) if row else None
            if not job:
                job = await asyncio.to_thread(runner.inspect, row.get('id') or identifier if row else identifier)
            plan = await asyncio.to_thread(runner.plan, job['id'])
        except (OSError, RuntimeError, ValueError):
            if row and action == 'status':
                return {**self.view(row), 'error': 'Runner is unavailable. Showing the saved workflow record.'}
            raise ConversationError('runner_unavailable', 'Runner is unavailable. No workflow action was submitted.') from None
        view = self.view(row, job, plan)
        if origin and view['originChatId'] != origin:
            raise ConversationError('unauthorized', 'This workflow does not belong to the selected conversation.')
        if action != 'status':
            if action not in ('cancel', 'resume', 'hold', 'release'):
                raise ConversationError('unsupported', 'This workflow action is unavailable.')
            try:
                await asyncio.to_thread(getattr(runner, action), job['id'])
                job = await asyncio.to_thread(runner.inspect, job['id'])
                plan = await asyncio.to_thread(runner.plan, job['id'])
            except (OSError, RuntimeError, ValueError):
                raise ConversationError('uncertain', 'Workflow action is unconfirmed. Inspect this same run before retrying.', uncertain=True) from None
            view = self.view(row, job, plan)
            self.chats.output(dict(type='workflow-updated', workflow=view))
        return view

    async def execute(self, op, args):
        if op == 'chat-workflow-runs':
            return await self.listing(args.get('offset', 0), args.get('limit', 20))
        if op == 'chat-workflow-list':
            return [self.view(row) for row in self.records() if row.get('originChatId') == args['chatId']]
        action = args.get('action', 'status') if op == 'workflow-run-action' else op.removeprefix('chat-workflow-')
        return await self.open(args['workflowId'], origin=args.get('chatId'), action='status' if action == 'open' else action)
