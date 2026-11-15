"""Fetch an explicitly pinned GitHub composition, never infer latest versions."""
import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from build_plan import extract_baseline
from components import require

from artifacts import DIGEST, digest_file


def download(url, sha256, destination):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.netloc == 'github.com' and not parsed.query and not parsed.fragment
            and parsed.path.startswith('/Aixand/aixand-suite/releases/download/')
            and '/latest/' not in parsed.path and DIGEST.fullmatch(sha256), 'Use an exact first-party GitHub release URL and SHA-256')
    request = urllib.request.Request(url, headers={'User-Agent': 'aixand-suite-composition'})
    with urllib.request.urlopen(request, timeout=60) as response, destination.open('xb') as output:
        require(urllib.parse.urlsplit(response.url).scheme == 'https', 'Download redirected away from HTTPS')
        size = 0
        while block := response.read(1024 * 1024):
            size += len(block)
            require(size <= 16 * 1024 ** 3, 'Composition object exceeds size limit')
            output.write(block)
    require(digest_file(destination) == sha256, 'Composition download checksum mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recipe', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    recipe = json.loads(args.recipe.read_text())
    require(set(recipe) == {'schema', 'runtime', 'composition'} and recipe['schema'] == 1, 'Unsupported composition recipe')
    require(not args.output.exists(), 'Use a fresh composition download directory')
    args.output.mkdir(parents=True)
    baseline = args.output / 'baseline'
    baseline.mkdir()
    download(recipe['runtime']['url'], recipe['runtime']['sha256'], baseline / 'runtime.tar.gz')
    extract_baseline(baseline, recipe['runtime']['sha256'], args.output / 'base')
    lock = recipe['composition']
    components = []
    for index, item in enumerate(lock['components']):
        require(set(item) == {'id', 'url', 'sha256'}, 'Component recipe needs ID, immutable URL and hash')
        file = f'component-{index}.tar.gz'
        download(item['url'], item['sha256'], args.output / file)
        components.append({'id': item['id'], 'file': file, 'sha256': item['sha256']})
    lock['components'] = components
    (args.output / 'composition-lock.json').write_text(json.dumps(lock, indent=2) + '\n')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        sys.exit(str(error))
