"""Real MCP lifecycle behind intercepted Suite browser transport."""
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from mcp_manager import Manager

root, bridge=Path(sys.argv[1]),Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('mcp_ui_bridge',bridge/'mcps.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
m=Manager(root/'mcp'); handler=module.Mcps(SimpleNamespace())
definition={'command':sys.executable,'args':['original']}
a=m.ensure_registered('fixture',definition,publisher_revision=1)
m.save_managed('fixture','default',definition|{'args':['mine']},expected_revision=a['revision'])
revision=1
for line in sys.stdin:
 request=json.loads(line)
 try:
  op,args=request['op'],request.get('args',{})
  if op=='fixture-update':
   revision+=1
   result=m.ensure_registered('fixture',definition|{'args':['publisher-'+str(revision)]},publisher_revision=revision)
  elif op=='fixture-content': result=m.resolve_managed('fixture')
  else: result=handler.managed(m,op,args)
  print(json.dumps({'id':request['id'],'result':result}),flush=True)
 except Exception as error:
  print(json.dumps({'id':request['id'],'error':str(error)}),flush=True)
