"""Fail closed while enabling the shared social proxy for the YouTube MCP."""
import os
import sys

try:
    sys.path.insert(0, os.environ.get('SOCIAL_PROXY_PACKAGE_DIR', '/data/repos/remy-watchers'))
    os.environ.setdefault('SOCIAL_PROXY_ENV_FILE', '/data/secrets/instagram.env')
    from social_proxy import install_from_file
    install_from_file()
except BaseException:
    # Python normally ignores sitecustomize import errors. Do not silently fall
    # back to a direct connection when the operator requires a proxy.
    os.write(2, b'YouTube social proxy setup failed; refusing direct traffic.\n')
    os._exit(78)
