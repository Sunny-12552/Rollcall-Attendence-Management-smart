from __future__ import annotations

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import io
import sqlite3
import secrets
from datetime import datetime

import pandas as pd
import streamlit as st
from google.auth.exceptions import GoogleAuthError
from streamlit.errors import StreamlitSecretNotFoundError
from sqlalchemy.exc import SQLAlchemyError

from streamlit_app.admin_service import (
    admin_audit,
    change_admin_status,
    invite_admin,
    list_devices,
    recover_admin,
    remove_admin,
    unlock_device,
    update_admin_details,
)
from streamlit_app.attendance_service import (
    AttendanceError,
    attendance_records,
    close_session,
    create_session,
    is_holiday,
    list_sessions,
    mark_attendance,
    percentage_records,
    recover_session,
    session_for_token,
    student_attendance_report,
    sync_percentage_sheet,
    today_and_time,
)
from streamlit_app.auth_service import (
    AuthenticationError,
    admin_accounts,
    approve_admin,
    bootstrap_main_admin,
    change_subjects,
    current_admin,
    login,
    logout,
    request_otp,
    reset_password,
    sign_up,
    verify_registration,
)
from streamlit_app.database import (
    cached_engine,
    ensure_target_database_is_separate,
    import_legacy_sqlite,
    initialize_database,
    row,
)
from streamlit_app.email_service import EmailDeliveryError
from streamlit_app.google_sheets import GoogleSheets
from streamlit_app.security import valid_student_name
from streamlit_app.settings import BATCHES, Settings, load_settings


st.set_page_config(
    page_title="Rollcall | QR Attendance",
    page_icon="✓",
    layout="wide",
    initial_sidebar_state="expanded",
)


@st.cache_resource(show_spinner=False)
def _engine(database_url: str):
    engine = cached_engine(database_url)
    initialize_database(engine)
    return engine


@st.cache_resource(show_spinner=False)
def _sheets(settings: Settings) -> GoogleSheets:
    return GoogleSheets(settings)


@st.cache_data(ttl=10, max_entries=32, show_spinner=False)
def _attendance_snapshot(
    spreadsheet_id: str,
    _sheets_client: GoogleSheets,
    subjects: tuple[str, ...],
) -> list[dict]:
    return attendance_records(_sheets_client, subjects)


def _settings() -> Settings:
    try:
        values = dict(st.secrets)
    except StreamlitSecretNotFoundError:
        values = {}
    return load_settings(values)


def _style() -> None:
    st.markdown(
        """
        <style>
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap');
        :root { --ink:#173232; --muted:#6a7c7a; --paper:#f6f3ee; --coral:#d97c67; --line:#dfe6dc; --dark:#153b3b; }
        .stApp { background-color:var(--paper); background-image:radial-gradient(#c5d0c5 1px,transparent 1px); background-size:18px 18px; color:var(--ink); }
        h1,h2,h3 { font-family:'Space Grotesk',sans-serif !important; color:var(--ink); letter-spacing:-.04em; }
        p, label, input, button, div[data-testid="stMarkdownContainer"] { font-family:'DM Sans',sans-serif; }
        div[data-testid="stVerticalBlockBorderWrapper"] { background:rgba(255,253,249,.93); border:1px solid var(--line); border-radius:18px; box-shadow:0 16px 34px rgba(17,39,39,.08); }
        .rollcall-brand { font-family:'Space Grotesk',sans-serif; font-size:26px; font-weight:700; color:var(--ink); }
        .rollcall-brand span { color:var(--coral); }
        .rollcall-eyebrow { color:var(--coral); font-size:11px; letter-spacing:.14em; font-weight:700; text-transform:uppercase; }
        div.stButton > button[kind="primary"] { background:linear-gradient(135deg,#153b3b,#1a4a4a); border:0; border-radius:12px; font-weight:700; }
        div.stButton > button { border-radius:12px; }
        section[data-testid="stSidebar"] { background:#edf1eb; }
        </style>
        """,
        unsafe_allow_html=True,
    )


def _settings_runtime() -> tuple[Settings, object]:
    settings = _settings()
    ensure_target_database_is_separate(
        settings.database_url, settings.source_database_path
    )
    engine = _engine(settings.database_url)
    source = settings.source_database_path
    if source and source != settings.database_url:
        marker = row(
            engine,
            "SELECT 1 AS found FROM streamlit_migrations WHERE source = :source",
            {"source": str(Path(source).expanduser().resolve())},
        )
        if not marker and Path(source).expanduser().is_file():
            try:
                import_legacy_sqlite(engine, source)
            except (OSError, ValueError, sqlite3.Error) as error:
                st.error(f"Could not import existing admin/device data: {error}")
    return settings, engine


def _sheets_or_error(settings: Settings) -> GoogleSheets | None:
    try:
        return _sheets(settings)
    except (GoogleAuthError, ValueError, OSError) as error:
        st.error(f"Google Sheets is unavailable: {error}")
        return None


def _header(subtitle: str = "") -> None:
    st.markdown('<div class="rollcall-brand">rollcall<span>.</span></div>', unsafe_allow_html=True)
    if subtitle:
        st.caption(subtitle)


def _require_main(admin: dict) -> None:
    if admin["effective_role"] != "MAIN_ADMIN":
        raise AuthenticationError("Main Admin access required.")


def _main_admin_exists(engine) -> bool:
    result = row(engine, "SELECT admin_id FROM main_admin_config WHERE singleton = 1")
    return bool(result and result["admin_id"])


def _login_view(settings: Settings, engine) -> None:
    _header("INSTRUCTOR ACCESS")
    st.title("Attendance, in control.")
    if not _main_admin_exists(engine):
        with st.expander("Set up or claim Main Admin", expanded=False):
            st.caption(
                "Use the bootstrap secret. To claim an existing admin, use that account's current email and password."
            )
            with st.form("bootstrap-form"):
                setup_name = st.text_input("Full name")
                setup_email = st.text_input("Admin email")
                setup_phone = st.text_input("Phone number")
                setup_password = st.text_input("Password", type="password")
                setup_confirm = st.text_input("Confirm password", type="password")
                setup_secret = st.text_input("Main Admin bootstrap secret", type="password")
                submitted = st.form_submit_button("Set up / claim Main Admin", type="primary")
            if submitted:
                try:
                    result = bootstrap_main_admin(
                        engine,
                        settings,
                        setup_name,
                        setup_email,
                        setup_phone,
                        setup_password,
                        setup_confirm,
                        setup_secret,
                    )
                    if result == "created":
                        st.success("Main Admin created. Enter the email OTP on the sign-in form to verify the account.")
                    else:
                        st.success("Existing verified admin account claimed as Main Admin. Sign in with its email and password.")
                except (AuthenticationError, EmailDeliveryError, ValueError) as error:
                    st.error(str(error))

    choice = st.radio(
        "Instructor account",
        ("Sign in", "Register", "Verify email", "Reset password"),
        horizontal=True,
        key="auth-view",
    )
    if choice == "Sign in":
        email = st.text_input("Admin email", key="login-email")
        with st.form("login-form"):
            password = st.text_input("Password", type="password", key="login-password")
            otp = st.text_input("One-time code (if requested)", max_chars=6)
            submitted = st.form_submit_button("Open dashboard", type="primary")
        if submitted:
            try:
                token, next_step = login(engine, email, password, otp.strip())
                st.session_state["auth_token"] = token
                if next_step == "password-change":
                    st.session_state["must_change_password"] = True
                st.rerun()
            except AuthenticationError as error:
                if str(error) == "OTP_REQUIRED":
                    st.info("Enter the one-time code sent to your email, then submit again.")
                else:
                    st.error(str(error))
        if st.button("Send password reset code"):
            try:
                request_otp(engine, settings, email, "reset")
                st.success("If this account is eligible, a reset code was sent. Check your inbox and spam folder.")
            except (AuthenticationError, EmailDeliveryError) as error:
                st.error(str(error))
    elif choice == "Register":
        with st.form("signup-form"):
            name = st.text_input("Full name")
            email = st.text_input("Email")
            phone = st.text_input("Phone number")
            password = st.text_input("Password", type="password")
            confirm = st.text_input("Confirm password", type="password")
            submitted = st.form_submit_button("Create admin request", type="primary")
        if submitted:
            try:
                sign_up(engine, settings, name, email, phone, password, confirm)
                st.success("Verification code sent. Verify your email; Main Admin approval is required before sign-in.")
                st.session_state["verify-email-value"] = email
            except (AuthenticationError, EmailDeliveryError, ValueError) as error:
                st.error(str(error))
    elif choice == "Verify email":
        with st.form("verify-form"):
            email = st.text_input("Admin email", value=st.session_state.get("verify-email-value", ""))
            code = st.text_input("One-time code", max_chars=6)
            submitted = st.form_submit_button("Verify email", type="primary")
        if submitted:
            try:
                verify_registration(engine, settings, email, code.strip())
                st.success("Email verified. Sign in to continue.")
            except (AuthenticationError, EmailDeliveryError) as error:
                st.error(str(error))
        if st.button("Resend verification code", key="resend-verify"):
            try:
                request_otp(engine, settings, email, "verify")
                st.success("If this account is eligible, a new code was sent.")
            except (AuthenticationError, EmailDeliveryError) as error:
                st.error(str(error))
    else:
        with st.form("reset-form"):
            email = st.text_input("Admin email")
            code = st.text_input("One-time code", max_chars=6)
            password = st.text_input("New password", type="password")
            confirm = st.text_input("Confirm new password", type="password")
            submitted = st.form_submit_button("Reset password", type="primary")
        if submitted:
            try:
                reset_password(engine, email, code.strip(), password, confirm)
                st.success("Password reset. Sign in with the new password.")
            except (AuthenticationError, EmailDeliveryError) as error:
                st.error(str(error))
        if st.button("Send reset code", key="request-reset"):
            try:
                request_otp(engine, settings, email, "reset")
                st.success("If this account is eligible, a reset code was sent.")
            except (AuthenticationError, EmailDeliveryError) as error:
                st.error(str(error))


def _student_view(settings: Settings, engine, sheets: GoogleSheets | None, token: str) -> None:
    _header("STUDENT CHECK-IN")
    st.title("Be counted. Keep moving.")
    session = session_for_token(engine, settings, token)
    if not session:
        st.error("This QR code is invalid, expired, or no longer authorized. Please scan a valid QR code.")
        return
    now_ms = int(datetime.now().timestamp() * 1000)
    if session["status"] != "active" or int(session["expires_at"]) <= now_ms:
        st.error("This QR code has expired. Please scan a valid QR code.")
        return
    st.info(
        f"{session['subject']}"
        + (f" · {session['batch']} only" if session["batch"] else "")
    )
    if sheets is None:
        st.error("Attendance cannot be saved until Google Sheets is configured.")
        return
    st.session_state.setdefault("device_token", secrets.token_urlsafe(24))
    with st.form("student-checkin"):
        name = st.text_input("Student name", placeholder="e.g. Rahul Kumar")
        batch = st.selectbox("Batch", BATCHES)
        email = st.text_input("Email for attendance updates (optional)")
        submitted = st.form_submit_button("Mark attendance", type="primary")
    if submitted:
        try:
            result = mark_attendance(
                engine,
                sheets,
                settings,
                token,
                name,
                batch,
                email,
                st.session_state["device_token"],
            )
            st.success(
                f"Attendance marked successfully. {result['name']} · {result['batch']} · "
                f"{result['course']} · {result['subject']} · {result['date']} · {result['status']}"
            )
            if result["email_status"] == "failed":
                st.warning("Attendance was recorded, but the confirmation email could not be sent.")
            if result["percentage_sync_status"] == "failed":
                st.warning(
                    "Attendance was recorded, but the Percentage worksheet did not synchronize."
                )
            _attendance_snapshot.clear()
            st.session_state["student-report-query"] = (result["name"], result["batch"])
        except (AttendanceError, AuthenticationError, EmailDeliveryError, OSError) as error:
            st.error(str(error))

    report = st.session_state.get("student-report-query")
    if report:
        st.subheader("Check your attendance")
        report_name = st.text_input("Student name", value=report[0], key="student-report-name")
        report_batch = st.selectbox(
            "Report batch",
            BATCHES,
            index=BATCHES.index(report[1]) if report[1] in BATCHES else 0,
            key="student-report-batch",
        )
        if st.button("Check attendance", key="check-student-report"):
            try:
                result = student_attendance_report(
                    sheets, report_name, report_batch, settings.subjects, settings
                )
                st.write(f"Today's status: **{result['today']['status']}**")
                st.metric("Overall attendance", f"{result['percentage']:.2f}%")
                st.caption(
                    f"{result['present_days']} Present / {result['total_days']} Total Days"
                )
                if result["low_attendance"]:
                    st.warning(
                        f"Attendance is below the required "
                        f"{settings.minimum_attendance_percentage:.0f}%."
                    )
            except (AttendanceError, OSError, ValueError) as error:
                st.error(str(error))


def _session_panel(settings: Settings, engine, sheets: GoogleSheets, admin: dict) -> None:
    st.subheader("New session")
    subjects = (
        settings.subjects
        if admin["effective_role"] == "MAIN_ADMIN"
        else tuple(subject for subject in settings.subjects if subject in admin["subjects"])
    )
    if not subjects:
        st.warning("No subjects have been assigned to this admin.")
        return
    with st.form("create-session"):
        subject = st.selectbox("Subject", subjects)
        batch = st.selectbox("Batch scope (optional)", ("All batches", *BATCHES))
        duration = st.selectbox("QR validity", (5, 10, 20, 30), index=3, format_func=lambda value: f"{value} minutes")
        submitted = st.form_submit_button("Generate QR", type="primary")
    if submitted:
        try:
            result = create_session(
                engine, sheets, settings, admin, subject,
                "" if batch == "All batches" else batch, duration,
            )
            st.session_state["last_qr_session"] = result
        except (AttendanceError, AuthenticationError, OSError, ValueError) as error:
            st.error(str(error))
    qr_session = st.session_state.get("last_qr_session")
    if qr_session:
        st.image(
            io.BytesIO(__import__("base64").b64decode(qr_session["qr_data"])),
            width=280,
            caption=f"{qr_session['subject']} · expires in {qr_session['duration_minutes']} minutes",
        )
        st.code(qr_session["url"], language=None)

    st.subheader("QR Session Recovery")
    for session in list_sessions(engine, admin):
        with st.expander(
            f"{session['subject']} · {session['attendance_date']} · "
            f"{session['status'].title()} · {session['marked_students']} marked"
        ):
            st.write(
                f"Session ID: `{session['id']}` | Scope: "
                f"{session['batch'] or 'All batches'} | Recovered: {session['recovery_count']} time(s)"
            )
            st.code(session["qr_url"], language=None)
            if session["status"] == "active":
                if session["expires_at"] <= int(datetime.now().timestamp() * 1000):
                    st.warning("This session expired. Close it to finalize absences.")
                if st.button("Close session and mark absences", key=f"close-{session['id']}"):
                    try:
                        result = close_session(engine, sheets, settings, session["id"])
                        st.success(f"Session closed. {result['added']} attendance statuses were finalized.")
                        if result.get("emailNotifications", {}).get("failed"):
                            st.warning(
                                f"{result['emailNotifications']['failed']} absence notification(s) failed."
                            )
                        if result.get("percentageSyncStatus") == "failed":
                            st.warning(
                                "The Percentage worksheet did not synchronize."
                            )
                        _attendance_snapshot.clear()
                        st.rerun()
                    except (AttendanceError, OSError, ValueError) as error:
                        st.error(str(error))
            else:
                if st.button("Recover this QR session", key=f"recover-{session['id']}"):
                    try:
                        recover_session(engine, admin, session["id"])
                        st.success("Session recovered. The original QR identity and URL are unchanged.")
                        st.rerun()
                    except (AttendanceError, AuthenticationError) as error:
                        st.error(str(error))


def _dashboard(settings: Settings, engine, admin: dict, sheets: GoogleSheets | None) -> None:
    _header(f"INSTRUCTOR DESK · {admin['name']}")
    st.title("Today's attendance")
    if st.sidebar.button("Log out"):
        logout(engine, st.session_state.get("auth_token", ""))
        st.session_state.pop("auth_token", None)
        st.session_state.pop("must_change_password", None)
        st.rerun()
    if admin["must_change_password"] or st.session_state.get("must_change_password"):
        st.warning("Choose a new password before using the dashboard.")
        with st.form("temporary-password-form"):
            new_password = st.text_input("New password", type="password")
            confirm = st.text_input("Confirm new password", type="password")
            submitted = st.form_submit_button("Save password", type="primary")
        if submitted:
            from streamlit_app.auth_service import change_temporary_password

            try:
                change_temporary_password(engine, admin, new_password, confirm)
                st.session_state.pop("must_change_password", None)
                st.success("Password changed.")
                st.rerun()
            except AuthenticationError as error:
                st.error(str(error))
        return

    if sheets is None:
        st.warning("Google Sheets is required for attendance, QR creation, and reporting.")
    navigation = ["Dashboard", "Attendance log", "Percentage report", "Device security"]
    if admin["effective_role"] == "MAIN_ADMIN":
        navigation.append("Admin management")
    page = st.sidebar.radio("Navigation", navigation)
    if page == "Dashboard":
        if sheets:
            _session_panel(settings, engine, sheets, admin)
            st.subheader("Send an attendance summary")
            with st.form("summary-email"):
                name = st.text_input("Student name")
                batch = st.selectbox("Batch", BATCHES, key="summary-batch")
                submitted = st.form_submit_button("Send summary")
            if submitted:
                try:
                    from streamlit_app.email_service import send_attendance_summary

                    student = next(
                        (
                            person
                            for person in sheets.students()
                            if person["name"].casefold() == name.casefold()
                            and person["batch"] == batch
                        ),
                        None,
                    )
                    if not student:
                        raise AttendanceError("Student not found in the roster.")
                    if not student["email"]:
                        raise AttendanceError("This student does not have an email address in the roster.")
                    report = _attendance_snapshot(
                        settings.spreadsheet_id,
                        sheets,
                        tuple(subject for subject in settings.subjects if subject in admin["subjects"])
                        if admin["effective_role"] != "MAIN_ADMIN"
                        else settings.subjects,
                    )
                    scoped = [
                        item for item in report
                        if item["name"].casefold() == name.casefold()
                        and item["batch"] == batch
                        and item["status"] in {"Present", "Absent"}
                    ]
                    summary = []
                    for subject in settings.subjects:
                        subject_rows = [item for item in scoped if item["subject"] == subject]
                        if subject_rows:
                            attended = sum(item["status"] == "Present" for item in subject_rows)
                            summary.append(
                                {
                                    "subject": subject,
                                    "present": attended,
                                    "total": len(subject_rows),
                                    "percentage": attended / len(subject_rows) * 100,
                                }
                            )
                    send_attendance_summary(settings, student["email"], name, summary)
                    st.success("Attendance summary sent.")
                except (AttendanceError, EmailDeliveryError, OSError, ValueError) as error:
                    st.error(str(error))
            st.subheader("Instructor correction")
            allowed_subjects = (
                tuple(settings.subjects)
                if admin["effective_role"] == "MAIN_ADMIN"
                else tuple(subject for subject in settings.subjects if subject in admin["subjects"])
            )
            if not allowed_subjects:
                st.warning("No subjects have been assigned to this admin.")
            else:
                with st.form("attendance-correction"):
                    correction_name = st.text_input("Student name", key="correct-name")
                    correction_batch = st.selectbox("Batch", BATCHES, key="correct-batch")
                    correction_subject = st.selectbox(
                        "Subject", allowed_subjects, key="correct-subject"
                    )
                    correction_date = st.date_input("Date", value=datetime.now().date())
                    correction_status = st.selectbox("Status", ("Present", "Absent"))
                    submitted = st.form_submit_button("Save correction")
                if submitted:
                    try:
                        day = correction_date.isoformat()
                        today = today_and_time(settings.timezone)[0]
                        if correction_subject not in allowed_subjects:
                            raise AuthenticationError("You do not have access to this subject.")
                        if correction_batch not in BATCHES or not valid_student_name(correction_name):
                            raise AttendanceError("Enter a valid student name and batch.")
                        if day > today or is_holiday(day, settings.holidays):
                            raise AttendanceError("Choose a valid class date up to today.")
                        student = sheets.ensure_student(correction_name, correction_batch, "")
                        sheets.write_attendance(
                            correction_subject,
                            day,
                            student["name"],
                            correction_batch,
                            correction_status,
                            student.get("id", ""),
                        )
                        if sync_percentage_sheet(sheets, settings.subjects):
                            _attendance_snapshot.clear()
                            st.success(f"Attendance correction saved for {day}.")
                        else:
                            _attendance_snapshot.clear()
                            st.warning(
                                f"Attendance correction saved for {day}, but the Percentage worksheet did not synchronize."
                            )
                    except (AttendanceError, AuthenticationError, OSError, ValueError) as error:
                        st.error(str(error))
    elif page == "Attendance log":
        if sheets:
            allowed = (
                tuple(settings.subjects)
                if admin["effective_role"] == "MAIN_ADMIN"
                else tuple(subject for subject in settings.subjects if subject in admin["subjects"])
            )
            try:
                records = _attendance_snapshot(settings.spreadsheet_id, sheets, allowed)
                frame = pd.DataFrame(records)
                if not frame.empty:
                    col1, col2 = st.columns(2)
                    batches = ["All batches", *sorted(frame["batch"].dropna().unique())]
                    selected_batch = col1.selectbox("Batch filter", batches)
                    selected_subject = col2.selectbox("Subject filter", ["All subjects", *allowed])
                    if selected_batch != "All batches":
                        frame = frame[frame["batch"] == selected_batch]
                    if selected_subject != "All subjects":
                        frame = frame[frame["subject"] == selected_subject]
                    st.dataframe(frame, width="stretch", hide_index=True)
                    st.download_button(
                        "Download CSV",
                        frame.to_csv(index=False).encode("utf-8"),
                        file_name="attendance-records.csv",
                        mime="text/csv",
                    )
                else:
                    st.info("No attendance records are available.")
            except (OSError, SQLAlchemyError, ValueError) as error:
                st.error(f"Unable to load attendance from Google Sheets: {error}")
    elif page == "Percentage report":
        if sheets:
            try:
                allowed = (
                    tuple(settings.subjects)
                    if admin["effective_role"] == "MAIN_ADMIN"
                    else tuple(subject for subject in settings.subjects if subject in admin["subjects"])
                )
                records = _attendance_snapshot(settings.spreadsheet_id, sheets, allowed)
                report = percentage_records(sheets.students(), records, allowed)
                frame = pd.DataFrame(report)
                st.dataframe(frame, width="stretch", hide_index=True)
                if not frame.empty:
                    st.download_button(
                        "Download CSV",
                        frame.to_csv(index=False).encode("utf-8"),
                        file_name="attendance-percentages.csv",
                        mime="text/csv",
                    )
            except (OSError, ValueError) as error:
                st.error(f"Unable to calculate attendance percentages: {error}")
    elif page == "Device security":
        st.subheader("Registered student devices")
        devices = list_devices(engine)
        active_devices = [device for device in devices if device["status"] == "active"]
        st.dataframe(pd.DataFrame(devices), width="stretch", hide_index=True)
        if active_devices:
            labels = {
                device["id"]: f"{device['student_name']} · {device['batch']} · {device['id']}"
                for device in active_devices
            }
            with st.form("unlock-device"):
                selected = st.selectbox(
                    "Device to release",
                    [device["id"] for device in active_devices],
                    format_func=lambda value: labels[value],
                )
                reason = st.text_input("Reason (5-500 characters)")
                submitted = st.form_submit_button("Release device")
            if submitted:
                try:
                    unlock_device(engine, admin, selected, reason)
                    st.success("Device released. The student can register a replacement on the next check-in.")
                    st.rerun()
                except AuthenticationError as error:
                    st.error(str(error))
        st.subheader("Device audit history")
        st.dataframe(
            pd.DataFrame(
                [
                    item for item in admin_audit(engine)
                    if item["action"] in {"device_unlock", "legacy_device_unlock"}
                ]
            ),
            width="stretch",
            hide_index=True,
        )
    else:
        _admin_management(settings, engine, admin)


def _admin_management(settings: Settings, engine, admin: dict) -> None:
    try:
        _require_main(admin)
    except AuthenticationError as error:
        st.error(str(error))
        return
    st.title("Admin logins & access")
    with st.expander("Invite an administrator"):
        with st.form("invite-admin"):
            name = st.text_input("Admin name")
            email = st.text_input("Invite email")
            subjects = st.multiselect("Subject access", settings.subjects)
            submitted = st.form_submit_button("Send invitation")
        if submitted:
            try:
                invite_admin(engine, settings, admin, name, email, subjects)
                st.success("Invitation and one-time code sent.")
            except (AuthenticationError, EmailDeliveryError, ValueError) as error:
                st.error(str(error))

    accounts = admin_accounts(engine)
    st.dataframe(
        pd.DataFrame(
            [
                {
                    "Name": item["name"],
                    "Email": item["email"],
                    "Phone": item["phone"],
                    "Role": item["effective_role"],
                    "Approval": item["approval_status"],
                    "Verified": bool(item["is_verified"]),
                    "Active": bool(item["is_active"]),
                    "Subjects": ", ".join(item["subjects"]),
                    "Last login": item["last_login"],
                }
                for item in accounts
            ]
        ),
        width="stretch",
        hide_index=True,
    )
    pending = [
        item for item in accounts
        if item["approval_status"] == "pending" or not item["is_verified"]
    ]
    if pending:
        st.subheader("Pending access requests")
        for target in pending:
            with st.expander(f"{target['name']} · {target['email']} · {target['approval_status']}"):
                if not target["is_verified"]:
                    st.info("This admin must verify their email before they can sign in.")
                    if st.button("Resend verification OTP", key=f"resend-{target['id']}"):
                        try:
                            request_otp(engine, settings, target["email"], "verify")
                            st.success("If eligible, a verification code was sent.")
                        except (AuthenticationError, EmailDeliveryError) as error:
                            st.error(str(error))
                reason = st.text_input(
                    "Approval/rejection reason",
                    key=f"approval-reason-{target['id']}",
                )
                col1, col2 = st.columns(2)
                if col1.button("Give access", key=f"approve-{target['id']}"):
                    try:
                        approve_admin(engine, settings, admin, target["id"], True, reason or "Main Admin granted access to this regular admin.")
                        st.success("Admin access approved.")
                        st.rerun()
                    except (AuthenticationError, ValueError) as error:
                        st.error(str(error))
                if col2.button("Reject", key=f"reject-{target['id']}"):
                    try:
                        approve_admin(engine, settings, admin, target["id"], False, reason)
                        st.success("Admin request rejected.")
                        st.rerun()
                    except (AuthenticationError, ValueError) as error:
                        st.error(str(error))

    st.subheader("Account management")
    for target in accounts:
        if target["effective_role"] == "MAIN_ADMIN":
            continue
        with st.expander(f"{target['name']} · {target['email']}"):
            with st.form(f"details-{target['id']}"):
                name = st.text_input("Name", target["name"], key=f"name-{target['id']}")
                email = st.text_input("Email", target["email"], key=f"email-{target['id']}")
                phone = st.text_input("Phone", target["phone"] or "", key=f"phone-{target['id']}")
                reason = st.text_input("Change reason", key=f"detail-reason-{target['id']}")
                submitted = st.form_submit_button("Save account details")
            if submitted:
                try:
                    update_admin_details(engine, admin, target["id"], name, email, phone, reason)
                    st.success("Admin details updated.")
                    st.rerun()
                except (AuthenticationError, ValueError) as error:
                    st.error(str(error))
            with st.form(f"subjects-{target['id']}"):
                selected_subjects = st.multiselect(
                    "Assigned subjects",
                    settings.subjects,
                    default=[subject for subject in target["subjects"] if subject in settings.subjects],
                    key=f"subjects-{target['id']}",
                )
                reason = st.text_input("Subject change reason", key=f"subject-reason-{target['id']}")
                submitted = st.form_submit_button("Update subject access")
            if submitted:
                try:
                    change_subjects(engine, settings, admin, target["id"], selected_subjects, reason)
                    st.success("Subject assignments updated.")
                    st.rerun()
                except (AuthenticationError, ValueError) as error:
                    st.error(str(error))
            status_reason = st.text_input("Status change reason", key=f"status-reason-{target['id']}")
            if target["is_active"]:
                if st.button("Deactivate admin", key=f"deactivate-{target['id']}"):
                    try:
                        notified = change_admin_status(engine, settings, admin, target["id"], False, status_reason)
                        if notified:
                            st.success("Admin deactivated and notified.")
                        else:
                            st.warning("Admin deactivated, but the notification email could not be delivered.")
                        st.rerun()
                    except (AuthenticationError, EmailDeliveryError, ValueError) as error:
                        st.error(str(error))
            else:
                if st.button("Reactivate admin", key=f"activate-{target['id']}"):
                    try:
                        notified = change_admin_status(engine, settings, admin, target["id"], True, status_reason)
                        if notified:
                            st.success("Admin reactivated and notified.")
                        else:
                            st.warning("Admin reactivated, but the notification email could not be delivered.")
                        st.rerun()
                    except (AuthenticationError, EmailDeliveryError, ValueError) as error:
                        st.error(str(error))
                if st.button("Recover admin account", key=f"admin-recover-{target['id']}"):
                    try:
                        recover_admin(engine, admin, target["id"], status_reason)
                        st.success("Admin account recovered.")
                        st.rerun()
                    except (AuthenticationError, ValueError) as error:
                        st.error(str(error))
            remove_reason = st.text_input("Removal reason", key=f"remove-reason-{target['id']}")
            confirm_remove = st.checkbox(
                "Confirm removal and anonymize this account",
                key=f"confirm-remove-{target['id']}",
            )
            if st.button("Remove admin", key=f"remove-{target['id']}"):
                try:
                    if not confirm_remove:
                        raise AuthenticationError("Confirm removal before continuing.")
                    remove_admin(engine, admin, target["id"], remove_reason)
                    st.success("Admin removed and personal details anonymized.")
                    st.rerun()
                except (AuthenticationError, ValueError) as error:
                    st.error(str(error))
    st.subheader("Admin login and access audit")
    st.dataframe(pd.DataFrame(admin_audit(engine, account_only=True)), width="stretch", hide_index=True)


def main() -> None:
    _style()
    try:
        settings, engine = _settings_runtime()
    except SQLAlchemyError:
        st.error("Unable to connect to the configured database. Check DATABASE_URL and database access.")
        st.stop()
    except (OSError, ValueError) as error:
        st.error(f"Application configuration error: {error}")
        st.stop()
    if settings.database_warning:
        st.warning(settings.database_warning)
    query_token = st.query_params.get("session", "")
    sheets = _sheets_or_error(settings)
    if query_token:
        _student_view(settings, engine, sheets, query_token)
        return

    login_token = st.session_state.get("auth_token", "")
    admin = current_admin(engine, login_token)
    if not admin:
        st.session_state.pop("auth_token", None)
        _login_view(settings, engine)
        return
    _dashboard(settings, engine, admin, sheets)


if __name__ == "__main__":
    main()
