from __future__ import annotations

import smtplib

import pytest

from streamlit_app import email_service
from streamlit_app.email_service import EmailDeliveryError
from streamlit_app.settings import load_settings


def _smtp_settings():
    return load_settings(
        {
            "EMAIL_PROVIDER": "smtp",
            "EMAIL_FROM": "attendance@example.com",
            "SMTP_HOST": "smtp.example.com",
            "SMTP_PORT": "587",
            "SMTP_SECURE": "false",
            "SMTP_USER": "attendance@example.com",
            "SMTP_PASSWORD": "test-app-password",
        }
    )


def test_smtp_authentication_failure_is_actionable_and_does_not_expose_secrets(
    monkeypatch,
):
    class FakeSmtp:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def starttls(self):
            pass

        def login(self, *_args):
            raise smtplib.SMTPAuthenticationError(535, b"private provider response")

    monkeypatch.setattr(email_service.smtplib, "SMTP", FakeSmtp)

    with pytest.raises(EmailDeliveryError) as error:
        email_service.send_email(
            _smtp_settings(), "student@example.com", "Subject", "Message"
        )

    message = str(error.value)
    assert "authentication was rejected" in message
    assert "535" in message
    assert "private provider response" not in message
    assert "test-app-password" not in message


def test_smtp_sender_rejection_is_actionable(monkeypatch):
    class FakeSmtp:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def starttls(self):
            pass

        def login(self, *_args):
            pass

        def send_message(self, *_args):
            raise smtplib.SMTPSenderRefused(
                553, b"private provider response", "attendance@example.com"
            )

    monkeypatch.setattr(email_service.smtplib, "SMTP", FakeSmtp)

    with pytest.raises(EmailDeliveryError, match="rejected the configured sender"):
        email_service.send_email(
            _smtp_settings(), "student@example.com", "Subject", "Message"
        )
