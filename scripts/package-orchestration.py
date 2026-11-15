"""Build Suite's standalone MCP product with pinned published API dependencies."""
from pathlib import Path
import argparse
import shutil
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/runtime'))
import dependencies


def local_projects(root=ROOT):
    return [tomllib.loads((root / project / 'pyproject.toml').read_text())['project']
            for project in ('mcps/orchestration', 'workflow/runner/python', 'services/connect')]


def build(output, target):
    sys.path.insert(0, str(ROOT / 'scripts/dev'))
    from catalog import host
    if target != host():
        raise ValueError('Build and qualify orchestration MCP on its native target')
    wheelhouse = output / 'wheelhouse'
    wheelhouse.mkdir(parents=True, exist_ok=True)
    dependencies.wheels(wheelhouse)
    constraint = dependencies.constraints(output / 'constraints.txt')
    projects = local_projects()
    with constraint.open('a') as stream:
        stream.write(''.join(f"{project['name']}=={project['version']}\n" for project in projects))
    orchestration = projects[0]
    for project in ('mcps/orchestration', 'workflow/runner/python', 'services/connect'):
        subprocess.run(['uv', 'build', '--wheel', '--no-sources', '--python', '3.12.14',
            '--out-dir', str(wheelhouse), str(ROOT / project)], check=True, stdout=sys.stderr)
    # Resolve the complete closure for the product-private interpreter. All
    # first-party external packages are constrained to the Suite dependency set.
    subprocess.run(['uv', 'run', '--no-project', '--python', '3.12.14', '--with', 'pip==26.2',
        'python', '-m', 'pip', 'download', '--only-binary=:all:', '--dest', str(wheelhouse),
        '--find-links', str(wheelhouse), '--constraint', str(constraint),
        f"{orchestration['name']}[runtime,resources,runner,carrier,connect]=={orchestration['version']}"],
        check=True, stdout=sys.stderr)
    constraint.unlink()
    notice = output / 'share/orchestration-mcp/LICENSE'
    notice.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / 'mcps/orchestration/LICENSE', notice)
    # Reuse the exact interpreter specification, retaining Suite's own path.
    sys.path.insert(0, str(ROOT / 'workflow/runner/scripts'))
    import prepare_runtime
    # Use Suite's runtime catalog. Runner's catalog also validates its external
    # source checkout, which is not an input of this standalone MCP product.
    prepare_runtime.ROOT = ROOT
    prepare_runtime.prepare(target)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--target', required=True)
    args = parser.parse_args()
    build(args.output.resolve(), args.target)
