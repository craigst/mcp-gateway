#!/usr/bin/env python3
"""Start an MCP module only after its social proxy has been installed."""
import runpy
import sys

from social_proxy import install_from_file

if len(sys.argv) < 3 or sys.argv[1] != '-m':
    raise SystemExit('Usage: social-proxy-run.py -m module [arguments...]')
install_from_file()
module = sys.argv[2]
sys.argv = [module, *sys.argv[3:]]
runpy.run_module(module, run_name='__main__', alter_sys=True)
