import unittest

import aixand
import intessio
from aixand import _connection
from intessio import _connection as legacy_connection
from intessio.errors import IntessioError


class RebrandCompatibilityTests(unittest.TestCase):
    def test_legacy_import_shares_connection_and_exception_identity(self):
        self.assertIs(intessio, aixand)
        self.assertIs(legacy_connection, _connection)
        self.assertIs(IntessioError, aixand.AixandError)
        self.assertIs(intessio.IntessioError, aixand.AixandError)
