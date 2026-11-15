"""Resolve authenticated build inputs into an offline signing descriptor."""
import argparse
import json
import shutil
import sys
from pathlib import Path

from build_plan import extract_baseline
from components import require
from stage import verified_runtime

from artifacts import digest_file


def prepare(descriptor, inputs, output):
    inputs, output = Path(inputs).resolve(), Path(output).resolve()
    require(not output.exists(), 'Signing preparation requires fresh output')
    def authenticated(file):
        file = Path(file)
        require(not file.is_symlink() and file.resolve().is_relative_to(inputs) and file.is_file(),
                'Payload must come from authenticated build artifacts')
        return file.resolve()
    if 'products' in descriptor:
        for item in descriptor['products']:
            item['file'] = str(authenticated(item['file']))
            item['qualification'] = str(authenticated(item['qualification']))
    elif 'components' in descriptor:
        for item in descriptor['components']:
            item['file'] = str(authenticated(item['file']))
    else:
        for index, item in enumerate(descriptor['artifacts']):
            item['file'] = str(authenticated(item['file']))
            if 'metadata' in item:
                item['metadata'] = str(authenticated(item['metadata']))
            if 'runtimeArchive' in item:
                archive = authenticated(item.pop('runtimeArchive'))
                digest = item.pop('runtimeArchiveSha256', digest_file(archive))
                staging = output / str(index) / 'archive'
                staging.mkdir(parents=True)
                shutil.copy2(archive, staging / 'runtime.tar.gz')
                runtime = extract_baseline(staging, digest, output / str(index) / 'extracted')
                verified_runtime(runtime)
                item['runtime'] = str(runtime)
            elif 'runtime' in item:
                runtime = Path(item['runtime']).resolve()
                require(runtime.is_relative_to(inputs), 'Runtime must come from authenticated build inputs')
                verified_runtime(runtime)
    output.mkdir(parents=True, exist_ok=True)
    file = output / 'descriptor.json'
    file.write_text(json.dumps(descriptor, indent=2) + '\n')
    return file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--descriptor', type=Path, required=True)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(prepare(json.loads(args.descriptor.read_text()), args.inputs, args.output))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        sys.exit(str(error))
