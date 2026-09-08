# Privacy and public-repository checklist

This repository is a sanitised portfolio version of a system created for a real
small-business workflow. It must contain only synthetic demonstration data.

Before every public release, verify that the repository does not contain:

- customer names, telephone numbers or addresses;
- real product prices or order histories;
- SQLite database, WAL or backup files;
- spreadsheets supplied by the business;
- installation archives or old release packages;
- passwords, API keys or `.env` files.

The `.gitignore` file excludes the common local-data paths, but it is not a
substitute for reviewing the files staged for each commit.
