"""Small stdio protocol fixture; never contacts a model or reads real logins."""
import json
import os
from pathlib import Path
import sys
import subprocess
import uuid


def executable(root):
    path = Path(root) / 'fixture-codex'
    path.write_text('#!' + sys.executable + '\n' + Path(__file__).read_text())
    path.chmod(0o700)
    return str(path)


def main():
    if sys.argv[1:] == ['--version']:
        print('codex-cli fixture')
        return
    if sys.argv[1:] == ['login', 'status']:
        return
    thread, approval = None, None

    def output(value):
        print(json.dumps(value), flush=True)

    def emit(method, **params):
        output({'method': method, 'params': {'threadId': thread['id'], **params}})

    def save():
        Path('.fixture-' + thread['id'] + '.json').write_text(json.dumps(thread))

    def finish(status='completed'):
        turn = thread['turns'][-1]
        turn['status'] = status
        if status == 'completed':
            prompt = turn['items'][0]['content'][0]['text']
            marker = Path('marker.txt').read_text() if Path('marker.txt').exists() else 'no marker'
            item = {'id': str(uuid.uuid4()), 'type': 'agentMessage', 'text': os.getcwd() + '\n' + marker}
            if 'AIXAND_TEST_REPORT' in prompt and not prompt.startswith('malformed'):
                result = subprocess.run([sys.executable, '-m', 'unittest', '-q'], capture_output=True, text=True)
                command = {'id': str(uuid.uuid4()), 'type': 'commandExecution', 'command': 'python -m unittest -q',
                           'exitCode': result.returncode, 'status': 'completed', 'aggregatedOutput': result.stdout + result.stderr}
                turn['items'].append(command)
                emit('item/completed', turnId=turn['id'], item=command)
                item['text'] = 'AIXAND_TEST_REPORT\n' + json.dumps({'outcome': 'passed' if result.returncode == 0 else 'failed',
                    'summary': 'Native project tests finished in ' + os.getcwd(),
                    'checks': [{'command': command['command'], 'exitCode': result.returncode}]})
            if 'Your final answer MUST be a JSON object' in (thread.get('developerInstructions') or ''):
                item['text'] = json.dumps({'outcome': 'completed', 'report': item['text']})
            turn['items'].append(item)
            emit('item/agentMessage/delta', turnId=turn['id'], itemId=item['id'], delta=item['text'])
            emit('item/completed', turnId=turn['id'], item=item)
        save()
        emit('turn/completed', turn=turn)

    for line in sys.stdin:
        message = json.loads(line)
        method, params = message.get('method'), message.get('params', {})
        if method == 'initialized':
            continue
        if method is None:
            if message['id'] == approval:
                finish()
                approval = None
            continue
        result = {}
        if method == 'thread/start':
            thread = {'id': str(uuid.uuid4()), 'cwd': os.getcwd(), 'turns': [],
                      'developerInstructions': params.get('developerInstructions')}
            save()
            result = {'thread': thread, 'model': 'fixture'}
        elif method == 'thread/resume':
            thread = json.loads(Path('.fixture-' + params['threadId'] + '.json').read_text())
            result = {'thread': thread, 'model': 'fixture'}
        elif method == 'thread/read':
            result = {'thread': thread}
        elif method == 'turn/start':
            turn = {'id': str(uuid.uuid4()), 'status': 'inProgress', 'items': [
                {'id': str(uuid.uuid4()), 'type': 'userMessage', 'content': params['input']}]}
            thread['turns'].append(turn)
            save()
            result = {'turn': turn}
        output({'id': message['id'], 'result': result})
        if method == 'turn/start':
            emit('turn/started', turn=turn)
            text = params['input'][0]['text']
            if text.startswith('approval'):
                approval = 42
                output({'id': approval, 'method': 'item/commandExecution/requestApproval',
                        'params': {'threadId': thread['id'], 'turnId': turn['id'], 'itemId': 'command',
                                   'command': 'cat marker.txt', 'cwd': os.getcwd()}})
            elif not text.startswith('slow'):
                finish()
        elif method == 'turn/interrupt':
            finish('interrupted')


if __name__ == '__main__':
    main()
