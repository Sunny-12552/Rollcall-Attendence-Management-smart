from __future__ import annotations

import html
import smtplib
import urllib.error
import urllib.request
from email.message import EmailMessage
from typing import Iterable

from streamlit_app.settings import Settings


class EmailDeliveryError(RuntimeError):
    pass


def _smtp_error_message(error: Exception) -> str:
    if isinstance(error, smtplib.SMTPAuthenticationError):
        return (
            f"SMTP authentication was rejected (server response {error.smtp_code}). "
            "Check SMTP_USER and the provider-specific password or app password."
        )
    if isinstance(error, smtplib.SMTPSenderRefused):
        return (
            f"SMTP rejected the configured sender (server response {error.smtp_code}). "
            "Check EMAIL_FROM and whether the account is authorized to send as it."
        )
    if isinstance(error, smtplib.SMTPRecipientsRefused):
        return "SMTP rejected the recipient address. Check that the email address is valid."
    if isinstance(error, smtplib.SMTPDataError):
        return (
            f"SMTP rejected the message (server response {error.smtp_code}). "
            "Check the sender and mail-provider sending restrictions."
        )
    if isinstance(error, smtplib.SMTPConnectError):
        return f"SMTP connection was rejected (server response {error.smtp_code})."
    if isinstance(error, smtplib.SMTPResponseException):
        return f"SMTP request was rejected (server response {error.smtp_code})."
    if isinstance(error, smtplib.SMTPServerDisconnected):
        return "The SMTP server disconnected before accepting the email."
    return f"SMTP delivery failed ({type(error).__name__}). Check the SMTP host, port, and TLS settings."


def email_configured(settings: Settings) -> bool:
    if settings.email_provider == "resend":
        return bool(settings.resend_api_key and settings.email_from)
    if settings.email_provider == "smtp":
        return bool(
            settings.smtp_host
            and settings.smtp_user
            and settings.smtp_password
            and settings.email_from
            and 1 <= settings.smtp_port <= 65535
        )
    return False


def send_email(
    settings: Settings, recipient: str, subject: str, text_body: str
) -> None:
    if not email_configured(settings):
        raise EmailDeliveryError("Email is not configured for the selected provider.")
    html_body = "<br>".join(
        html.escape(line) if line else "&nbsp;"
        for line in text_body.splitlines()
    )
    if settings.email_provider == "resend":
        import json

        payload = json.dumps(
            {
                "from": f"Attendance Management System <{settings.email_from}>",
                "to": [recipient],
                "subject": subject.replace("\r", " ").replace("\n", " ")[:120],
                "text": text_body,
                "html": f"<div>{html_body}</div>",
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            "https://api.resend.com/emails",
            data=payload,
            headers={
                "Authorization": f"Bearer {settings.resend_api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                if not 200 <= response.status < 300:
                    raise EmailDeliveryError("The Resend API rejected the email.")
        except (urllib.error.URLError, TimeoutError) as error:
            raise EmailDeliveryError("Unable to deliver email through Resend.") from error
        return

    message = EmailMessage()
    message["Subject"] = subject.replace("\r", " ").replace("\n", " ")[:120]
    message["From"] = f"Attendance Management System <{settings.email_from}>"
    message["To"] = recipient
    message.set_content(text_body)
    message.add_alternative(f"<div>{html_body}</div>", subtype="html")
    try:
        if settings.smtp_secure:
            with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15) as client:
                client.login(settings.smtp_user, settings.smtp_password)
                client.send_message(message)
        else:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as client:
                client.starttls()
                client.login(settings.smtp_user, settings.smtp_password)
                client.send_message(message)
    except (OSError, smtplib.SMTPException) as error:
        raise EmailDeliveryError(_smtp_error_message(error)) from error


def send_otp(
    settings: Settings,
    recipient: str,
    name: str,
    code: str,
    purpose: str,
    temporary_password: str = "",
) -> None:
    if purpose == "reset":
        subject = "Attendance Management System - Password Reset OTP"
        intro = "We received a request to reset your administrator password."
    elif purpose == "invite":
        subject = "Attendance Management System - Administrator Invitation"
        intro = "Use this temporary password and one-time code to sign in, then choose a permanent password."
    else:
        subject = "Attendance Management System - Verify Your Account"
        intro = "Complete administrator account verification with this one-time code."
    lines = [
        f"Hello {name or 'there'},",
        "",
        intro,
    ]
    if temporary_password:
        lines.extend(["", f"Temporary password: {temporary_password}"])
    lines.extend(
        [
            "",
            f"Your verification code (valid for 10 minutes): {code}",
            "",
            "Do not share this code with anyone.",
        ]
    )
    send_email(settings, recipient, subject, "\n".join(lines))


def send_attendance_notice(
    settings: Settings,
    recipient: str,
    student_name: str,
    subject: str,
    date: str,
    status: str,
    faculty_name: str = "",
) -> None:
    send_email(
        settings,
        recipient,
        f"Attendance {status} - {subject}",
        "\n".join(
            [
                f"Hello {student_name},",
                "",
                f"Your attendance is recorded as {status}.",
                f"Subject: {subject}",
                f"Date: {date}",
                f"Faculty: {faculty_name or 'Attendance team'}",
            ]
        ),
    )


def send_attendance_summary(
    settings: Settings,
    recipient: str,
    student_name: str,
    subject_rows: Iterable[dict],
) -> None:
    summary = list(subject_rows)
    present = sum(int(item["present"]) for item in summary)
    total = sum(int(item["total"]) for item in summary)
    percentage = (present / total * 100) if total else 0
    lines = [
        f"Hello {student_name},",
        "",
        f"Overall attendance: {percentage:.2f}% ({present}/{total})",
    ]
    lines.extend(
        f"{item['subject']}: {item['present']}/{item['total']} "
        f"({item['percentage']:.2f}%)"
        for item in summary
    )
    send_email(
        settings,
        recipient,
        f"Attendance Summary - {student_name}",
        "\n".join(lines),
    )
