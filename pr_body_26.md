## Description

Prevents orphaned/indented code blocks from reaching production by adding the integration-service to the Python services CI matrix with a mandatory syntax compilation step.

## Changes

- Added integration-service to the Python services CI matrix
- Added a `python -m py_compile main.py` syntax check step for all Python services
- Added test environment variables for the integration service
- Made the pytest step conditional on test files existing

## Why

The integration service previously had no CI coverage. An indented orphaned code block (issue #26) could have caused an IndentationError at module load time, making the service completely non-functional. The py_compile step catches these errors before code reaches production.

Fixes #26
