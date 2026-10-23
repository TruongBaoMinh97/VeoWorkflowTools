import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parents[2]
database = root / 'full-release/Veo Workflow Tools-win32-x64/resources/server/prisma/template.db'
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
    tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    assert all(connection.execute('SELECT count(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0] == 0 for table in tables), 'Template includes user data'
    print('Release template verified empty:', len(tables), 'tables')
