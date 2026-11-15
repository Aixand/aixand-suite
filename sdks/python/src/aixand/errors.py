"""Composition failures; underlying SDK errors otherwise retain their original types."""


class AixandError(Exception):
    pass


# Retained for callers catching the pre-rebrand exception name.
IntessioError = AixandError


class ConnectionClosed(AixandError):
    pass


class ConsumerError(AixandError):
    def __init__(self, address, session_id, cause):
        self.address, self.session_id, self.cause = address, session_id, cause
        super().__init__(f"Carrier consumer {address!r} for {session_id} failed: {cause}")


class AcceptanceTimeout(AixandError):
    """Terminal input was written, but the agent has not confirmed acceptance."""


class DeliveryUncertain(AixandError):
    """Input might have been delivered. No input was automatically replayed."""


class AgentSetupError(AixandError):
    def __init__(self, agent, cause):
        self.agent, self.cause = agent, cause
        super().__init__(f"Agent {agent.run_id} was launched but setup failed: {cause}. "
                         "The handle is available as error.agent; stop or inspect it explicitly.")
