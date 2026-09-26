from __future__ import annotations

import unittest

import evidence_server as server


class EvidenceServerUnitTests(unittest.TestCase):
    def test_sanitize_id(self) -> None:
        self.assertEqual(server.sanitize_id("KIAA0513 / O60268"), "KIAA0513_O60268")
        self.assertEqual(server.sanitize_id("../../"), "protein")

    def test_bearer_auth(self) -> None:
        service = server.EvidenceService.__new__(server.EvidenceService)
        service.token = "secret-token"
        self.assertTrue(service.authorized("Bearer secret-token"))
        self.assertFalse(service.authorized("Bearer wrong"))
        service.token = ""
        self.assertTrue(service.authorized(""))


if __name__ == "__main__":
    unittest.main()
