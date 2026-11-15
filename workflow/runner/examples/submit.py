"""Run with PYTHONPATH=python python examples/submit.py --home /path/to/state."""
import argparse
import json
from pathlib import Path
from runner_client import Client

parser = argparse.ArgumentParser()
parser.add_argument("--home")
parser.add_argument("--key", default="python-verifier-example")
args = parser.parse_args()
directory = Path(__file__).parent
client = Client(args.home)
submitted = client.submit(
    json.loads((directory / "verify.json").read_text()),
    json.loads((directory / "inputs.json").read_text()),
    key=args.key,
)
job_id = submitted["job"]["id"]
print("Job:", job_id, "replayed:", submitted["replayed"])
for event in client.follow(job_id):
    print(json.dumps(event))
print(json.dumps(client.result(job_id), indent=2))
