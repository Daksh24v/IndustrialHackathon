"""Tell the maintenance team: every report lands in the on-screen inbox, and with RESEND_API_KEY and
MAINTENANCE_EMAIL in .env it is also emailed (Resend's HTTP API; MAIL_FROM sets the sender, default Resend's test
sender). The email goes in the background: a slow or failing mail service never holds up or breaks a turn."""

import logging
import os
import threading

import httpx

from server.reports import Message, Reports

RESEND_URL = "https://api.resend.com/emails"
DEFAULT_FROM = "FINNI <onboarding@resend.dev>"
TIMEOUT_S = 10
log = logging.getLogger(__name__)


def email_configured() -> bool:
    return bool(os.environ.get("RESEND_API_KEY", "").strip() and os.environ.get("MAINTENANCE_EMAIL", "").strip())


def tell_maintenance(reports: Reports, building_id: str, subject: str, body: str) -> Message:
    """Into the inbox now; by email too when it is set up (the message's delivery says how it went)."""
    message = reports.post(Message(building_id, subject, body, delivery="emailing" if email_configured() else "inbox"))
    if message.delivery == "emailing":
        threading.Thread(target=_send, args=(reports, message), name="maintenance-email", daemon=True).start()
    return message


def _send(reports: Reports, message: Message) -> None:
    try:
        response = httpx.post(
            RESEND_URL,
            headers={"Authorization": f"Bearer {os.environ['RESEND_API_KEY'].strip()}"},
            json={"from": os.environ.get("MAIL_FROM", DEFAULT_FROM), "to": [os.environ["MAINTENANCE_EMAIL"].strip()],
                  "subject": message.subject, "text": message.body},
            timeout=TIMEOUT_S,
        )
        response.raise_for_status()
        message.delivery = "emailed"
    except Exception as error:  # the inbox still has it
        log.warning("Maintenance email failed: %s", error)
        message.delivery = f"email failed: {type(error).__name__}"
    reports.post_updated()
