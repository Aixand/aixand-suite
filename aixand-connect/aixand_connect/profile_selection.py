"""Portable execution intent. Account selection happens on the target device."""
import re

from .protocol import ConnectError

NAME = r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
SCHEMA = {'type': 'object', 'properties': {
    'mode': {'type': 'string', 'enum': ['auto', 'specific', 'direct']},
    'profile': {'type': 'string', 'pattern': NAME}},
    'required': ['mode'], 'additionalProperties': False,
    'description': 'Defaults to Auto: Agent Manager on the target chooses the eligible account with the most weekly allowance remaining. Specific requires a profile name. Direct explicitly uses the device native Codex login (or controller profile on the Suite host). No automatic fallback.'}


def validate(value=None):
    value = {'mode': 'auto'} if value is None else value
    if not isinstance(value, dict) or value.get('mode') not in ('auto', 'specific', 'direct'):
        raise ConnectError('Choose auto, specific, or direct profile selection')
    if value['mode'] == 'specific':
        if set(value) != {'mode', 'profile'} or not isinstance(value['profile'], str) or not re.fullmatch(NAME, value['profile']):
            raise ConnectError('Specific selection requires an exact profile name')
    elif set(value) != {'mode'}:
        raise ConnectError('Only specific selection accepts a profile name')
    return dict(value)


def from_args(args):
    if args.get('remoteProfile') is not None:
        if 'profileSelection' in args:
            raise ConnectError('Choose remoteProfile or profileSelection, not both')
        return validate({'mode': 'specific', 'profile': args['remoteProfile']})
    return validate(args.get('profileSelection'))


def public(decision):
    return {key: decision.get(key) for key in ('profile', 'auth', 'quota', 'reason', 'requested')} if decision else None
