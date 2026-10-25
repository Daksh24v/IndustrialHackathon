"""What people reported as broken, for everyone in the building: a lift, stairs, a door or a room out of service.
Every conversation about the building routes around it and the map shows it red until someone says it works again.
Each report also goes to the maintenance inbox (and by email when that is set up, see notify.py).

Live website only: the benchmark never sees these. Kept in the running server's memory: the building's own data
is never changed, and a restart starts clean (FINNI_REPORTS_FILE keeps them in a file across restarts)."""

import json
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

MAX_INBOX = 200


@dataclass
class Report:
    element_id: str
    building_id: str
    kind: str  # lift, stairs, door, room
    label: str  # "Office lift (Ground floor ↔ Floor 1)"
    floor_ids: list[str]
    problem: str  # in the words used: "the lift is broken"
    reported_at: float = field(default_factory=time.time)


@dataclass
class Message:
    """One message to the maintenance team."""

    building_id: str
    subject: str
    body: str
    sent_at: float = field(default_factory=time.time)
    delivery: str = "inbox"  # inbox, emailed or "email failed: ..."


class Reports:
    def __init__(self, path: Path | None = None):
        self.path = path
        self._lock = threading.Lock()
        self._reports: dict[str, dict[str, Report]] = {}  # building id -> element id -> report
        self.inbox: list[Message] = []
        self._load()

    def ids(self, building_id: str) -> set[str]:
        with self._lock:
            return set(self._reports.get(building_id, {}))

    def of(self, building_id: str) -> list[Report]:
        with self._lock:
            return sorted(self._reports.get(building_id, {}).values(), key=lambda report: report.reported_at)

    def add(self, report: Report) -> Report:
        """A new report, or the same thing reported again (keeps the first time it was reported)."""
        with self._lock:
            known = self._reports.setdefault(report.building_id, {}).get(report.element_id)
            if known is None:
                self._reports[report.building_id][report.element_id] = report
            self._save()
            return known or report

    def clear(self, building_id: str, element_id: str) -> Report | None:
        with self._lock:
            report = self._reports.get(building_id, {}).pop(element_id, None)
            self._save()
            return report

    def post(self, message: Message) -> Message:
        with self._lock:
            self.inbox.append(message)
            del self.inbox[:-MAX_INBOX]
            self._save()
            return message

    def post_updated(self) -> None:
        """A message's delivery changed (the email went out, or didn't): keep it."""
        with self._lock:
            self._save()

    def messages(self, building_id: str | None = None) -> list[Message]:
        with self._lock:
            return [message for message in reversed(self.inbox) if building_id in (None, message.building_id)]

    def _save(self) -> None:
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            data = {"reports": [asdict(report) for reports in self._reports.values() for report in reports.values()],
                    "inbox": [asdict(message) for message in self.inbox]}
            partial = self.path.with_name(self.path.name + ".partial")
            partial.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            partial.replace(self.path)
        except OSError:  # a read-only disk must not break the reports themselves
            pass

    def _load(self) -> None:
        if self.path is None or not self.path.is_file():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            for item in data.get("reports", []):
                report = Report(**item)
                self._reports.setdefault(report.building_id, {})[report.element_id] = report
            self.inbox = [Message(**item) for item in data.get("inbox", [])]
        except (OSError, ValueError, TypeError):  # a damaged file starts over rather than stopping the server
            self._reports, self.inbox = {}, []
