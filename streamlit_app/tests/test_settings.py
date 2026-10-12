from __future__ import annotations

from pathlib import Path

from sqlalchemy.engine import make_url

from streamlit_app import settings as settings_module


def test_load_settings_reads_project_root_env(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text(
        "GOOGLE_SPREADSHEET_ID=local-spreadsheet\n"
        "GOOGLE_SERVICE_ACCOUNT_FILE=local-service-account.json\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings_module, "ROOT", tmp_path)
    monkeypatch.delenv("GOOGLE_SPREADSHEET_ID", raising=False)
    monkeypatch.delenv("GOOGLE_SERVICE_ACCOUNT_FILE", raising=False)

    settings = settings_module.load_settings()

    assert settings.spreadsheet_id == "local-spreadsheet"
    assert settings.service_account_file == "local-service-account.json"


def test_streamlit_secrets_override_env_values(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text(
        "GOOGLE_SPREADSHEET_ID=local-spreadsheet\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings_module, "ROOT", tmp_path)
    monkeypatch.delenv("GOOGLE_SPREADSHEET_ID", raising=False)

    settings = settings_module.load_settings(
        {"GOOGLE_SPREADSHEET_ID": "streamlit-secret-spreadsheet"}
    )

    assert settings.spreadsheet_id == "streamlit-secret-spreadsheet"


def test_plain_node_database_path_uses_separate_streamlit_database(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(settings_module, "ROOT", tmp_path)
    monkeypatch.setenv("DATABASE_URL", "data/attendance.sqlite")
    monkeypatch.delenv("STREAMLIT_DATABASE_URL", raising=False)

    settings = settings_module.load_settings()

    expected_database = (
        tmp_path / "streamlit_app" / "data" / "rollcall.sqlite"
    ).resolve()
    actual_database = Path(make_url(settings.database_url).database).resolve()
    assert actual_database == expected_database
    assert "separate local database" in settings.database_warning


def test_streamlit_database_file_path_is_normalized(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_module, "ROOT", tmp_path)
    monkeypatch.setenv("STREAMLIT_DATABASE_URL", "streamlit_app/data/custom.sqlite")
    monkeypatch.delenv("DATABASE_URL", raising=False)

    settings = settings_module.load_settings()

    actual_database = Path(make_url(settings.database_url).database).resolve()
    assert actual_database == (
        tmp_path / "streamlit_app" / "data" / "custom.sqlite"
    ).resolve()
    assert settings.database_warning == ""
