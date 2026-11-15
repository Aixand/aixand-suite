"""Disposable offline Carrier for the full chat browser fixture."""
import sys
import uvicorn
from carrier.service import create_app

if __name__ == '__main__':
    uvicorn.run(create_app(sys.argv[1]), host='127.0.0.1', port=int(sys.argv[2]),
                log_level='warning', lifespan='off', ws='none')
