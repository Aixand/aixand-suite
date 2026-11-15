"""Test the native lifecycle hook and real MCP delivery without a model."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tomllib
import uuid

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def install(root):
    program = Path(root) / 'fixture-codex'
    program.write_text('#!' + sys.executable + '\nimport runpy\nrunpy.run_path(' +
        repr(str(Path(__file__).resolve())) + ', run_name="__main__")\n')
    program.chmod(0o700)
    return program


def value(result):
    if result.isError:
        raise RuntimeError('Fixture MCP call failed')
    return result.structuredContent or json.loads(result.content[0].text)


async def main():
    settings = {}
    for index, arg in enumerate(sys.argv[:-1]):
        if arg == '-c':
            key, text = sys.argv[index + 1].split('=', 1)
            settings[key] = tomllib.loads('value = ' + text)['value']
    parameters = StdioServerParameters(command=settings['mcp_servers.carrier.command'], args=settings['mcp_servers.carrier.args'])
    async with stdio_client(parameters) as streams, ClientSession(*streams) as tools:
        await tools.initialize()
        thread = str(uuid.uuid4())
        async with asyncio.timeout(20):
            while True:
                result = value(await tools.call_tool('bind_conversation', {'session_id': thread, 'hook_event_name': 'SessionStart'}))
                if result.get('continue') is not False:
                    break
                await asyncio.sleep(.1)
        print('Native Carrier fixture is ready in ' + os.getcwd(), flush=True)
        while True:
            page = value(await tools.call_tool('receive_pending', {'limit': 50}))
            for message in page['messages']:
                try:
                    request = json.loads(message['content'])
                except ValueError:
                    request = None
                if isinstance(request, dict) and request.get('kind') == 'task.request':
                    content = json.dumps({'schema': 'aixand.carrier', 'version': 1, 'kind': 'task.completed',
                        'title': 'Work completed', 'body': 'Completed: ' + request['body'],
                        'run_id': request['run_id'], 'project_id': request.get('project_id', '')})
                else:
                    content = 'Reply: ' + message['content']
                value(await tools.call_tool('send', {'to': message['sender'], 'reply_to': message['id'],
                    'content': content, 'message_id': 'fixture-answer:' + str(message['id'])}))
                value(await tools.call_tool('ack', {'message_id': message['id']}))
            await asyncio.sleep(.1)


if __name__ == '__main__':
    asyncio.run(main())
