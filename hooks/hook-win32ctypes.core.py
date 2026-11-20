# Override hook to fix Python 3.13 crash (0xC0000005) in isolated subprocess
# Original hook calls collect_submodules('win32ctypes.core.ctypes') which crashes
# We manually list the known submodules instead
hiddenimports = [
    'win32ctypes.core.ctypes',
    'win32ctypes.core.ctypes._common',
    'win32ctypes.core.ctypes._authentication',
    'win32ctypes.core.ctypes._advapi32',
    'win32ctypes.core.ctypes._kernel32',
]
