"""SDK-free tool schema helpers."""

from ..errors import OrchestrationError

S = {"type": "string", "minLength": 1, "maxLength": 256}
DIRECTORY = {"type": "string", "minLength": 1, "maxLength": 4096}
TEXT = {"type": "string", "minLength": 1, "maxLength": 32000}
BOOL = {"type": "boolean"}
OBJECT = {"type": "object"}
CURSOR = {"type": "integer", "minimum": 0}


def tool(name, description, properties=None, required=(), *, mutation=False):
    properties = dict(properties or {})
    if mutation:
        properties["operation_id"] = S
        required = (*required, "operation_id")
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": list(required),
            "additionalProperties": False,
        },
    }


def validate(value, schema):
    kind = schema.get("type")
    match = {
        "string": lambda v: isinstance(v, str),
        "object": lambda v: isinstance(v, dict),
        "array": lambda v: isinstance(v, list),
        "boolean": lambda v: isinstance(v, bool),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    }
    if kind and not match[kind](value):
        raise OrchestrationError("validation", "Tool argument has the wrong type")
    if "enum" in schema and value not in schema["enum"]:
        raise OrchestrationError("validation", "Choose an advertised argument value")
    if kind == "object":
        fields = schema.get("properties", {})
        if (
            set(schema.get("required", [])) - set(value)
            or schema.get("additionalProperties") is False
            and set(value) - set(fields)
        ):
            raise OrchestrationError(
                "validation", "Tool arguments do not match the contract"
            )
        for key, item in value.items():
            if key in fields:
                validate(item, fields[key])
    if kind in ("string", "array"):
        if len(value) < schema.get("minLength", schema.get("minItems", 0)) or len(
            value
        ) > schema.get("maxLength", schema.get("maxItems", 1000000)):
            raise OrchestrationError("validation", "Tool argument exceeds its bounds")
        if kind == "array":
            for item in value:
                validate(item, schema.get("items", {}))
    if kind == "integer" and not schema.get(
        "minimum", -(10**30)
    ) <= value <= schema.get("maximum", 10**30):
        raise OrchestrationError("validation", "Tool argument exceeds its bounds")
