"""Select an authorized component build from trusted event fields."""
import os
import sys

from components import ROOT, load_catalog, release_selection, require, native_role


def main():
    catalog = load_catalog()
    if os.environ.get("EVENT_NAME") == "push":
        names = release_selection(catalog, ROOT, os.environ.get("RELEASE_TAG", ""))
        require(len(names) == 1, "Use the Suite workflow for composition releases")
        component = names[0]
        role = native_role(os.environ.get("RELEASE_TAG", "").split("/", 1)[0])
    else:
        require(os.environ.get("EVENT_NAME") == "workflow_dispatch", "Unsupported release event")
        component = os.environ.get("COMPONENT", "")
        require(component in catalog["components"] or component == "client", "Unknown component selection")
        role = native_role(component)
        component = "desktop" if component == "client" else component
    print("component=" + component)
    print("role=" + (role or ""))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        sys.exit(str(error))
