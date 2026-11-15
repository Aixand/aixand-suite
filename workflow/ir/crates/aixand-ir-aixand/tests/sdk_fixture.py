# Test fixtures only. Production adapters, scheduling and lowering are Rust.
import asyncio
import json
import tempfile
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock
import agent_manager
import carrier
import httpx
import aixand
import undercurrent
from aixand._binding import Binding

class Runtime:
    home = '/test/runtime'
    def __init__(self):
        self.revision = 1
        self.waits, self.inputs, self.stops = [], [], []
        self.no_revision = False
        self.uncertain = False
    async def connect(self): pass
    async def close(self): pass
    def session(self, id):
        return undercurrent.Session(dict(id=id, name='test', revision=self.revision,
            lifecycle={'state':'running'}, foreground={'execution':{'state':'running'},
            'interaction':{'state':'available'}, 'constraint':{'state':'clear'}},health={'status':'healthy'}))
    async def wait_for_stability(self, session, **kwargs):
        self.waits.append(kwargs)
        return self.session(session)
    async def send_input(self, session, text, **kwargs):
        self.inputs.append((text, kwargs))
        if self.uncertain:
            raise undercurrent.UndercurrentError('wire lost', effect_certainty='unknown')
        self.revision += 1
        return undercurrent.InputReceipt(session, 1, kwargs['delivery_id'], False,
                                        None if self.no_revision or (getattr(self, 'revisionless_second', False) and len(self.inputs)==2) else self.revision)
    async def inspect(self, session):
        if getattr(self, 'inject_carrier', False):
            self.inject_carrier = False
            await deliver_carrier()
        return self.session(session)
    async def read_screen(self, session): return b'hello\xff'
    async def stop(self, session, **kwargs):
        self.stops.append(session)
        return self.session(session)
    async def wait(self, *args, **kwargs): await asyncio.Future()

class Manager:
    def __init__(self, provider, **kwargs):
        self.provider = provider
        self.context = agent_manager.Context(kwargs.get('labels'), kwargs.get('metadata')).as_dict()
    def with_context(self, **kwargs):
        import copy
        view = copy.copy(self)
        view.context = agent_manager.Context(**self.context).resolve(**kwargs).as_dict()
        return view
    async def spawn(self, **kwargs):
        global counter
        counter += 1
        return agent_manager.Agent('run'+str(counter), self.provider, kwargs['profile'], None,
                                   '/test/agent', 'session'+str(counter), labels=kwargs.get('labels', {}))
    async def get(self, run_id):
        return agent_manager.Agent(run_id,self.provider,'research',None,'/test/agent','session-'+run_id)
    async def close(self): pass

counter = 0
agent_manager.Client = Manager
runtime = Runtime()
temp = tempfile.TemporaryDirectory()
connection = aixand.connect(runtime=runtime,state_dir=temp.name,timeout=1,stable_for=0)

# Real Carrier client and Message implementations over a controlled HTTP boundary.
requests = []
outgoing = []
pending_entered = threading.Event()
pending_cancelled = threading.Event()
mode = 'reply'
async def transport(request):
    requests.append(request.url.path)
    if request.url.path == '/whoami': return httpx.Response(200,json={'address':'coordinator'})
    if request.url.path == '/capabilities': return httpx.Response(200,json={'features':['addressed_send','reply_to']})
    if request.url.path == '/send':
        body=json.loads(request.content)
        outgoing.append(body)
        return httpx.Response(200,json=dict(id=7,sender='coordinator',recipient=body['to'],content=body['content'],
            created_at='now',message_id=body.get('message_id'),reply_to=body.get('reply_to'),acknowledged_at=None))
    if request.url.path == '/receive_pending':
        if mode == 'pending':
            pending_entered.set()
            try:
                await asyncio.Future()
            finally:
                pending_cancelled.set()
        if mode == 'failure':
            agent = next(iter(connection.agents))
            binding = SimpleNamespace(address='brain',agent=agent)
            asyncio.get_running_loop().set_exception_handler(lambda *_:None)
            connection._record_failure(binding,carrier.TransportError('consumer failed'))
            await asyncio.Future()
        messages=[] if mode=='timeout' else [dict(id=8,sender='implementer',recipient='coordinator',content='{"answer":"done"}',
            created_at='now',message_id=None,reply_to=7,acknowledged_at=None)]
        return httpx.Response(200,json={'messages':messages,'next_after':None})
    if request.url.path == '/ack': return httpx.Response(200,json={'id':8,'acknowledged_at':'later','status':'acknowledged'})
    raise AssertionError(request.url.path)
mailbox = carrier.Client(token='test-only',transport=httpx.MockTransport(transport))
async def open_mailbox(address, **kwargs):
    await mailbox.open()
    return mailbox
connection._carrier.mailbox = open_mailbox
original_close=connection._carrier.close
async def close_carrier():
    await mailbox.close()
    await original_close()
connection._carrier.close=close_carrier

async def deliver_carrier():
    agent = connection.agents[0]
    inbox = SimpleNamespace(address='worker',url='http://test')
    receipts = SimpleNamespace(address='receipts')
    binding = Binding(agent,inbox,receipts)
    binding.accept=AsyncMock()
    agent._binding=binding
    message=carrier.Message(9,'peer','worker','hello','now',None,None,None,SimpleNamespace(ack=AsyncMock(return_value={'acknowledged_at':'now'})))
    await binding.deliver(message)

async def installed_application(*, connection, arguments):
    assert connection._parent is globals()['connection']
    assert connection.context['labels']['workflow.step_id']
    return {'observed': arguments, 'accepted': True}
