"""Simple PostgreSQL client using psycopg3 with auto-reconnect functionality."""

from __future__ import annotations

import os
from io import StringIO
from functools import wraps
from pathlib import Path
from typing import Any, Callable, TypeVar
from urllib.parse import quote_plus

# uv pip install "psycopg[binary]"
import pandas as pd
import psycopg
from dotenv import load_dotenv

T = TypeVar("T")


def create_postgres_url(
    host: str,
    port: int,
    database: str,
    username: str,
    password: str,
    **kwargs: Any,
) -> str:
    """Create a PostgreSQL connection URL from individual components.

    Args:
        host: Database host
        port: Database port
        database: Database name
        username: Database username
        password: Database password
        **kwargs: Additional connection parameters (e.g., sslmode='require')

    Returns:
        PostgreSQL connection URL string
    """
    # URL-encode password to handle special characters
    encoded_password = quote_plus(password)
    url = f"postgresql://{username}:{encoded_password}@{host}:{port}/{database}"

    if kwargs:
        params = "&".join(f"{k}={v}" for k, v in kwargs.items())
        url += f"?{params}"

    return url


def with_reconnect(func: Callable[..., T]) -> Callable[..., T]:
    """Decorator to automatically reconnect on connection errors.

    Catches psycopg.OperationalError and psycopg.InterfaceError,
    resets the connection, and retries the operation once.
    """

    @wraps(func)
    def wrapper(self: PostgresClient, *args: Any, **kwargs: Any) -> T:
        try:
            return func(self, *args, **kwargs)
        except (psycopg.OperationalError, psycopg.InterfaceError):
            # Connection lost, retry once with fresh connection
            self._conn = None
            return func(self, *args, **kwargs)

    return wrapper


class PostgresClient:
    """Simple PostgreSQL client with auto-reconnect functionality."""

    def __init__(self, connection_url: str | None = None):
        """Initialize the PostgreSQL client.

        Args:
            connection_url: PostgreSQL connection URL. If None, loads from
                          POSTGRES_URL or DATABASE_URL environment variable.
        """
        if connection_url is None:
            connection_url = os.getenv("POSTGRES_URL") or os.getenv("DATABASE_URL")
            if not connection_url:
                error_msg = (
                    "No connection URL provided and POSTGRES_URL/DATABASE_URL environment variable not found"
                )
                raise ValueError(error_msg)

        self.connection_url = connection_url
        self._conn: psycopg.Connection | None = None

    @property
    def conn(self) -> psycopg.Connection:
        """Get connection, establishing or re-establishing if needed."""
        if self._conn is None or self._conn.closed:
            self._conn = psycopg.connect(self.connection_url, autocommit=True)
        return self._conn

    def transaction(self):
        """Return a transaction context manager.

        Usage:
            with client.transaction():
                client.execute("INSERT ...")
                client.execute("UPDATE ...")
            # auto-commits on success, auto-rolls back on exception
        """
        return self.conn.transaction()

    @with_reconnect
    def execute(self, query: str, params: tuple | None = None) -> list[tuple]:
        """Execute a query and return all results.

        Args:
            query: SQL query to execute
            params: Query parameters (uses %s placeholders)

        Returns:
            List of result tuples
        """
        with self.conn.cursor() as cur:
            cur.execute(query, params)
            if cur.description:  # Query returns results
                return cur.fetchall()
            return []

    @with_reconnect
    def execute_one(self, query: str, params: tuple | None = None) -> tuple | None:
        """Execute a query and return the first result.

        Args:
            query: SQL query to execute
            params: Query parameters (uses %s placeholders)

        Returns:
            First result tuple or None
        """
        with self.conn.cursor() as cur:
            cur.execute(query, params)
            if cur.description:
                return cur.fetchone()
            return None

    @with_reconnect
    def select(self, query: str, params: tuple | None = None) -> list[dict[str, Any]]:
        """Execute a SELECT query and return results with column names.

        Args:
            query: SQL SELECT query to execute
            params: Query parameters (uses %s placeholders)

        Returns:
            List of dictionaries, where each dictionary has column names as keys
            and query results as values
        """
        with self.conn.cursor() as cur:
            cur.execute(query, params)
            if cur.description:
                columns = [desc[0] for desc in cur.description]
                rows = cur.fetchall()
                return [dict(zip(columns, row)) for row in rows]
            return []

    @with_reconnect
    def execute_many(self, query: str, params_list: list[tuple]) -> None:
        """Execute a query multiple times with different parameters.

        Caller should wrap in a transaction() block for atomicity.

        Args:
            query: SQL query to execute
            params_list: List of parameter tuples
        """
        with self.conn.cursor() as cur:
            cur.executemany(query, params_list)

    @staticmethod
    def _quote_identifier(identifier: str) -> str:
        """Quote a SQL identifier with double quotes."""
        return f'"{identifier.replace("\"", "\"\"")}"'

    @classmethod
    def _qualify_table_name(cls, table_name: str, schema: str | None = None) -> str:
        """Return a safely quoted table reference."""
        quoted_table = cls._quote_identifier(table_name)
        if schema:
            return f"{cls._quote_identifier(schema)}.{quoted_table}"
        return quoted_table

    @staticmethod
    def _postgres_type_for_series(series: pd.Series) -> str:
        """Map pandas dtype to a PostgreSQL column type."""
        dtype = series.dtype

        if pd.api.types.is_bool_dtype(dtype):
            return "BOOLEAN"
        if pd.api.types.is_integer_dtype(dtype):
            itemsize = getattr(dtype, "itemsize", 8)
            if itemsize <= 2:
                return "SMALLINT"
            if itemsize <= 4:
                return "INTEGER"
            return "BIGINT"
        if pd.api.types.is_float_dtype(dtype):
            return "DOUBLE PRECISION"
        if pd.api.types.is_datetime64_any_dtype(dtype):
            return "TIMESTAMP"
        if pd.api.types.is_timedelta64_dtype(dtype):
            return "INTERVAL"
        # Covers object/string/category and unknown extension dtypes.
        return "TEXT"

    @classmethod
    def create_table_query_from_dataframe(
        cls,
        df: pd.DataFrame,
        table_name: str,
        schema: str | None = None,
        *,
        if_not_exists: bool = True,
    ) -> str:
        """Build a CREATE TABLE statement inferred from a DataFrame schema.

        Args:
            df: DataFrame providing column names and dtypes.
            table_name: Target table name.
            schema: Optional schema name.
            if_not_exists: Add IF NOT EXISTS clause when True.

        Returns:
            SQL CREATE TABLE statement.
        """
        if len(df.columns) == 0:
            raise ValueError("DataFrame must have at least one column")

        table_ref = cls._qualify_table_name(table_name, schema=schema)
        ine_clause = " IF NOT EXISTS" if if_not_exists else ""
        column_defs = []
        for col in df.columns:
            pg_type = cls._postgres_type_for_series(df[col])
            column_defs.append(f"{cls._quote_identifier(str(col))} {pg_type}")

        cols_sql = ",\n    ".join(column_defs)
        return f"CREATE TABLE{ine_clause} {table_ref} (\n    {cols_sql}\n);"

    @with_reconnect
    def insert_dataframe(
        self,
        df: pd.DataFrame,
        table_name: str,
        schema: str | None = None,
    ) -> int:
        """Insert all rows from DataFrame into table using COPY with CSV input.

        Args:
            df: Source DataFrame.
            table_name: Target table name.
            schema: Optional target schema.

        Returns:
            Number of inserted rows.
        """
        if len(df.columns) == 0:
            raise ValueError("DataFrame must have at least one column")
        if df.empty:
            return 0

        table_ref = self._qualify_table_name(table_name, schema=schema)
        columns_sql = ", ".join(self._quote_identifier(str(col)) for col in df.columns)
        copy_sql = f"COPY {table_ref} ({columns_sql}) FROM STDIN WITH (FORMAT csv, NULL '\\N')"

        csv_buffer = StringIO()
        df.to_csv(csv_buffer, index=False, header=False, na_rep="\\N")
        with self.conn.cursor() as cur:
            with cur.copy(copy_sql) as copy:
                copy.write(csv_buffer.getvalue())
        return len(df)

    def list_tables(
        self,
        schema: str | None = None,
        *,
        include_schema: bool = False,
    ) -> list[tuple[str, str]] | list[str]:
        """List all tables in the database.

        Args:
            schema: Filter by specific schema. If None, returns tables from all
                   user schemas (excludes pg_catalog and information_schema).
            include_schema: If True, returns (schema, table_name) tuples.
                          If False, returns just table names.

        Returns:
            List of (schema, table_name) tuples if include_schema=True,
            otherwise list of table names.
        """
        if schema:
            query = """
                SELECT table_schema, table_name
                FROM information_schema.tables
                WHERE table_schema = %s
                AND table_type = 'BASE TABLE'
                ORDER BY table_schema, table_name
            """
            results = self.execute(query, (schema,))
        else:
            query = """
                SELECT table_schema, table_name
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                AND table_type = 'BASE TABLE'
                ORDER BY table_schema, table_name
            """
            results = self.execute(query)

        if include_schema:
            return results
        return [table_name for _, table_name in results]

    @with_reconnect
    def list_schemas(
        self,
        exclude_prefixes: list[str] | None = None,
    ) -> list[str]:
        """List all schemas in the database.

        Args:
            exclude_prefixes: List of prefixes to exclude. Schemas whose names
                            begin with any of these prefixes will be filtered out.
                            Defaults to ["pg_temp", "pg_toast_temp"].

        Returns:
            List of schema names.
        """
        if exclude_prefixes is None:
            exclude_prefixes = ["pg_temp", "pg_toast_temp"]

        query = """
            SELECT schema_name
            FROM information_schema.schemata
            ORDER BY schema_name
        """
        results = self.execute(query)
        schema_names = [schema_name for (schema_name,) in results]

        # Filter out schemas that start with any of the exclude_prefixes
        return [
            schema for schema in schema_names if not any(schema.startswith(prefix) for prefix in exclude_prefixes)
        ]

    def hung(self):
        q = """
        SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
        FROM pg_stat_activity
        WHERE state = 'active' AND (now() - pg_stat_activity.query_start) > interval '5 minutes';
        """
        return self.select(q)

    def index_status(self):
        q = "SELECT * FROM pg_stat_progress_create_index;"
        return self.select(q)

    def close(self) -> None:
        """Close the database connection."""
        if self._conn and not self._conn.closed:
            self._conn.close()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - closes connection."""
        self.close()
