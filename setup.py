from cx_Freeze import setup, Executable

# Dependencies are automatically detected, but it might need
# fine tuning.
build_options = {'packages': [], 'excludes': []}

base = 'gui'

executables = [
    Executable('winSTT.py', base=base, target_name = 'winSTT.py')
]

setup(name='winstt',
      version = '0.1',
      description = 'speech to text app',
      options = {'build_exe': build_options},
      executables = executables)
