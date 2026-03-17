# blueprints/__init__.py
# ----------------------
# Empty package marker. Declaring this directory as a Python package
# allows function_app.py to import blueprints with clean dotted paths:
#
#   from blueprints.ingestion_bp import bp as ingestion_bp
#   from blueprints.arrival_bp   import bp as arrival_bp
#
# No logic lives here — this file exists solely for Python's import system.
