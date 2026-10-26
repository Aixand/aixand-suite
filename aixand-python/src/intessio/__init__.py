"""Compatibility import for applications installed before the Aixand rebrand."""
import sys

import aixand as _aixand

# Both spellings must share classes and the default connection, including private
# modules used by older SDK bindings. Do not load a second copy of the SDK.
_aixand.IntessioError = _aixand.AixandError
for _name, _module in tuple(sys.modules.items()):
    if _name == "aixand" or _name.startswith("aixand."):
        sys.modules["intessio" + _name[len("aixand"):]] = _module
