# Security policy

## Supported releases

Security fixes are provided for the newest tagged release. Development branches
and historical RSI versions are research artifacts, not supported deployments.

## Reporting a vulnerability

Do not open a public issue for credentials, identity leakage, path traversal,
unsafe archive extraction, command injection, or a way to bypass the frozen
resource boundary. Use GitHub's private vulnerability reporting for this
repository. Include the affected commit/tag, platform, minimal reproduction,
and whether any protein identity, credential, or private benchmark data was
exposed.

Never attach real API tokens, private Gold, target identity maps, or complete
private run directories. Replace secrets immediately if accidental disclosure
is suspected.

## Deployment boundary

The included evidence server and Compose file are local research conveniences.
They do not provide TLS, multi-user isolation, quotas, a hardened sandbox, or a
production secrets boundary. See `docs/PORTABILITY.md` before network exposure.
