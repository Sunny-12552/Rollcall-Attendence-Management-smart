from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from streamlit_app.settings import Settings, load_service_account


SCOPES = ("https://www.googleapis.com/auth/spreadsheets",)
STUDENT_HEADERS = ("Student ID", "Student Name", "Batch", "Email")
PERCENTAGE_HEADERS = (
    "Student Name",
    "Batch",
    "Course",
    "Subject",
    "Attended Classes",
    "Total Classes",
    "Subject Percentage",
    "Full-Course / Overall Percentage",
)


def _build_service(account_json: str):
    import json

    credentials = Credentials.from_service_account_info(
        json.loads(account_json), scopes=SCOPES
    )
    return build("sheets", "v4", credentials=credentials, cache_discovery=False)


@lru_cache(maxsize=4)
def _cached_service(account_json: str):
    return _build_service(account_json)


class GoogleSheets:
    def __init__(self, settings: Settings):
        if not settings.spreadsheet_id:
            raise ValueError("GOOGLE_SPREADSHEET_ID is not configured.")
        credentials = load_service_account(settings)
        import json

        self.spreadsheet_id = settings.spreadsheet_id
        self.service = _cached_service(
            json.dumps(credentials, sort_keys=True, separators=(",", ":"))
        )
        self.subjects = settings.subjects
        self._titles: dict[str, str] | None = None

    def _metadata(self) -> dict[str, int]:
        response = (
            self.service.spreadsheets()
            .get(
                spreadsheetId=self.spreadsheet_id,
                fields="sheets.properties(title,sheetId)",
            )
            .execute()
        )
        return {
            sheet["properties"]["title"]: sheet["properties"]["sheetId"]
            for sheet in response.get("sheets", [])
        }

    def resolve_subject_titles(self) -> dict[str, str]:
        if self._titles is not None:
            return self._titles
        existing = self._metadata()
        titles: dict[str, str] = {}
        used: set[str] = set()
        for index, subject in enumerate(self.subjects, start=1):
            candidates = (subject, f"Subject {index}", f"Sheet{index}")
            title = next(
                (candidate for candidate in candidates if candidate in existing and candidate not in used),
                None,
            )
            if title is None and index == 1 and "Sheet1" in existing:
                title = "Sheet1"
            if title is None:
                raise ValueError(
                    f"Missing worksheet for subject {subject!r}; expected its configured title "
                    f"or the existing legacy tab 'Subject {index}'. No sheet was renamed or created."
                )
            titles[subject] = title
            used.add(title)
        self._titles = titles
        return titles

    def subject_title(self, subject: str) -> str:
        try:
            return self.resolve_subject_titles()[subject]
        except KeyError as error:
            raise ValueError("Select a configured subject.") from error

    def values(self, range_name: str) -> list[list[Any]]:
        result = (
            self.service.spreadsheets()
            .values()
            .get(
                spreadsheetId=self.spreadsheet_id,
                range=range_name,
                valueRenderOption="UNFORMATTED_VALUE",
            )
            .execute()
        )
        return result.get("values", [])

    def batch_values(self, ranges: list[str]) -> list[list[list[Any]]]:
        if not ranges:
            return []
        result = (
            self.service.spreadsheets()
            .values()
            .batchGet(
                spreadsheetId=self.spreadsheet_id,
                ranges=ranges,
                valueRenderOption="UNFORMATTED_VALUE",
            )
            .execute()
        )
        return [
            item.get("values", [])
            for item in result.get("valueRanges", [])
        ]

    def students(self) -> list[dict[str, str]]:
        matrix = self.values("'Students'!A1:D10000")
        students = []
        for row in matrix[1:]:
            student_id = str(row[0] if len(row) > 0 else "").strip()
            name = " ".join(str(row[1] if len(row) > 1 else "").split())
            batch = str(row[2] if len(row) > 2 else "").strip()
            email = str(row[3] if len(row) > 3 else "").strip().lower()
            if name and batch:
                students.append(
                    {
                        "id": student_id,
                        "name": name,
                        "batch": batch,
                        "email": email,
                    }
                )
        return students

    def subject_matrices(self, subjects: tuple[str, ...] | None = None) -> dict[str, list[list[Any]]]:
        selected = subjects or self.subjects
        titles = self.resolve_subject_titles()
        ranges = [f"'{titles[subject]}'!A1:ZZ10000" for subject in selected]
        return dict(zip(selected, self.batch_values(ranges), strict=True))

    def _sheet_id(self, title: str) -> int:
        ids = self._metadata()
        if title not in ids:
            raise ValueError(f"Worksheet not found: {title}")
        return ids[title]

    def update_cell(self, range_name: str, value: Any) -> None:
        (
            self.service.spreadsheets()
            .values()
            .update(
                spreadsheetId=self.spreadsheet_id,
                range=range_name,
                valueInputOption="USER_ENTERED",
                body={"values": [[value]]},
            )
            .execute()
        )

    def ensure_student(
        self,
        name: str,
        batch: str,
        email: str,
        students: list[dict[str, str]] | None = None,
    ) -> dict[str, str]:
        existing = next(
            (
                student
                for student in (students if students is not None else self.students())
                if student["name"].casefold() == name.casefold()
                and student["batch"] == batch
            ),
            None,
        )
        if existing:
            if email and not existing["email"]:
                matrix = self.values("'Students'!A1:D10000")
                row_index = next(
                    (
                        index
                        for index, row in enumerate(matrix[1:], start=2)
                        if " ".join(str(row[1] if len(row) > 1 else "").split()).casefold()
                        == name.casefold()
                        and str(row[2] if len(row) > 2 else "").strip() == batch
                    ),
                    None,
                )
                if row_index:
                    self.update_cell(f"'Students'!D{row_index}", email)
                    existing["email"] = email
            return existing

        append = (
            self.service.spreadsheets()
            .values()
            .append(
                spreadsheetId=self.spreadsheet_id,
                range="'Students'!A:D",
                valueInputOption="USER_ENTERED",
                insertDataOption="INSERT_ROWS",
                body={
                    "values": [
                        [
                            '=IF(OR(INDEX(B:B,ROW())="",INDEX(C:C,ROW())=""),"","STU-"&TEXT(ROW()-1,"000000"))',
                            name,
                            batch,
                            email,
                        ]
                    ]
                },
            )
            .execute()
        )
        row_index = int(
            append.get("updates", {}).get("updatedRange", "'Students'!A1:D1")
            .split("!")[1]
            .split(":")[0][1:]
        )
        returned = self.values(f"'Students'!A{row_index}:D{row_index}")
        student_id = str(returned[0][0] if returned and returned[0] else "").strip()
        student = {"id": student_id, "name": name, "batch": batch, "email": email}
        self.sync_student_to_subjects(student)
        return student

    def sync_student_to_subjects(self, student: dict[str, str]) -> None:
        matrices = self.subject_matrices()
        titles = self.resolve_subject_titles()
        updates = []
        for subject, matrix in matrices.items():
            matrix = matrix or [["Student ID", "Student Name", "Batch"]]
            match = next(
                (
                    index
                    for index, row in enumerate(matrix[1:], start=2)
                    if (
                        student["id"]
                        and str(row[0] if len(row) > 0 else "").strip() == student["id"]
                    )
                    or (
                        " ".join(str(row[1] if len(row) > 1 else "").split()).casefold()
                        == student["name"].casefold()
                        and str(row[2] if len(row) > 2 else "").strip() == student["batch"]
                    )
                ),
                None,
            )
            if match is not None:
                continue
            target_row = len(matrix) + 1
            updates.append(
                {
                    "range": f"'{titles[subject]}'!A{target_row}:C{target_row}",
                    "values": [[student["id"], student["name"], student["batch"]]],
                }
            )
        if updates:
            self.service.spreadsheets().values().batchUpdate(
                spreadsheetId=self.spreadsheet_id,
                body={"valueInputOption": "USER_ENTERED", "data": updates},
            ).execute()

    def write_attendance(
        self,
        subject: str,
        date: str,
        name: str,
        batch: str,
        status: str,
        student_id: str = "",
    ) -> None:
        title = self.subject_title(subject)
        matrix = self.values(f"'{title}'!A1:ZZ10000")
        if not matrix:
            raise ValueError(f"Worksheet {title!r} has no header row.")
        header = matrix[0]
        student_row = next(
            (
                index
                for index, row in enumerate(matrix[1:], start=2)
                if (
                    student_id
                    and str(row[0] if len(row) > 0 else "").strip() == student_id
                )
                or (
                    " ".join(str(row[1] if len(row) > 1 else "").split()).casefold()
                    == name.casefold()
                    and str(row[2] if len(row) > 2 else "").strip() == batch
                )
            ),
            None,
        )
        if student_row is None:
            raise ValueError("Student roster row is missing from the subject worksheet.")

        date_column = next(
            (
                index
                for index, value in enumerate(header[3:], start=3)
                if str(value).strip() == date
            ),
            None,
        )
        if date_column is None:
            date_indexes = [
                index
                for index, value in enumerate(header[3:], start=3)
                if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value).strip())
            ]
            destination_index = max(3, len(header))
            sheet_id = self._sheet_id(title)
            requests = [
                {
                    "insertDimension": {
                        "range": {
                            "sheetId": sheet_id,
                            "dimension": "COLUMNS",
                            "startIndex": destination_index,
                            "endIndex": destination_index + 1,
                        },
                        "inheritFromBefore": False,
                    }
                }
            ]
            if date_indexes:
                source_index = date_indexes[-1]
                requests.append(
                    {
                        "copyPaste": {
                            "source": {
                                "sheetId": sheet_id,
                                "startRowIndex": 0,
                                "endRowIndex": max(1000, len(matrix)),
                                "startColumnIndex": source_index,
                                "endColumnIndex": source_index + 1,
                            },
                            "destination": {
                                "sheetId": sheet_id,
                                "startRowIndex": 0,
                                "endRowIndex": max(1000, len(matrix)),
                                "startColumnIndex": destination_index,
                                "endColumnIndex": destination_index + 1,
                            },
                            "pasteType": "PASTE_FORMAT",
                        }
                    }
                )
            requests.extend(
                [
                    {
                        "updateDimensionProperties": {
                            "range": {
                                "sheetId": sheet_id,
                                "dimension": "COLUMNS",
                                "startIndex": destination_index,
                                "endIndex": destination_index + 1,
                            },
                            "properties": {"pixelSize": 100},
                            "fields": "pixelSize",
                        }
                    },
                    {
                        "setDataValidation": {
                            "range": {
                                "sheetId": sheet_id,
                                "startRowIndex": 1,
                                "endRowIndex": max(1000, len(matrix)),
                                "startColumnIndex": destination_index,
                                "endColumnIndex": destination_index + 1,
                            },
                            "rule": {
                                "condition": {
                                    "type": "ONE_OF_LIST",
                                    "values": [
                                        {"userEnteredValue": status}
                                        for status in ("Present", "Absent", "Holiday")
                                    ],
                                },
                                "showCustomUi": True,
                                "strict": False,
                            },
                        }
                    },
                ]
            )
            for format_status, color in (
                ("Present", {"red": 0.86, "green": 0.95, "blue": 0.88}),
                ("Absent", {"red": 0.98, "green": 0.88, "blue": 0.86}),
                ("Holiday", {"red": 0.86, "green": 0.92, "blue": 0.98}),
            ):
                requests.append(
                    {
                        "addConditionalFormatRule": {
                            "rule": {
                                "ranges": [
                                    {
                                        "sheetId": sheet_id,
                                        "startRowIndex": 1,
                                        "endRowIndex": max(1000, len(matrix)),
                                        "startColumnIndex": destination_index,
                                        "endColumnIndex": destination_index + 1,
                                    }
                                ],
                                "booleanRule": {
                                    "condition": {
                                        "type": "TEXT_EQ",
                                        "values": [{"userEnteredValue": format_status}],
                                    },
                                    "format": {"backgroundColor": color},
                                },
                            },
                            "index": 0,
                        }
                    }
                )
            self.service.spreadsheets().batchUpdate(
                spreadsheetId=self.spreadsheet_id,
                body={"requests": requests},
            ).execute()
            self.update_cell(
                f"'{title}'!{column_name(destination_index)}1", date
            )
            date_column = destination_index
        self.update_cell(f"'{title}'!{column_name(date_column)}{student_row}", status)

    def update_recovered_absence(
        self,
        subject: str,
        date: str,
        name: str,
        batch: str,
        student_id: str = "",
    ) -> bool:
        title = self.subject_title(subject)
        matrix = self.values(f"'{title}'!A1:ZZ10000")
        if not matrix:
            return False
        date_column = next(
            (
                index
                for index, value in enumerate(matrix[0][3:], start=3)
                if str(value).strip() == date
            ),
            None,
        )
        row_index = next(
            (
                index
                for index, row in enumerate(matrix[1:], start=2)
                if (
                    student_id
                    and str(row[0] if len(row) > 0 else "").strip() == student_id
                )
                or (
                    " ".join(str(row[1] if len(row) > 1 else "").split()).casefold()
                    == name.casefold()
                    and str(row[2] if len(row) > 2 else "").strip() == batch
                )
            ),
            None,
        )
        if date_column is None or row_index is None:
            return False
        if str(matrix[row_index - 1][date_column] if len(matrix[row_index - 1]) > date_column else "").strip() != "Absent":
            return False
        self.update_cell(f"'{title}'!{column_name(date_column)}{row_index}", "Present")
        return True

    def write_percentage(self, values: list[list[Any]]) -> None:
        if not values:
            raise ValueError("The derived attendance percentage report cannot be empty.")
        existing = self.values("'Percentage'!A:H")
        (
            self.service.spreadsheets()
            .values()
            .update(
                spreadsheetId=self.spreadsheet_id,
                range=f"'Percentage'!A1:H{len(values)}",
                valueInputOption="USER_ENTERED",
                body={"values": values},
            )
            .execute()
        )
        stale_start = len(values) + 1
        stale_end = len(existing)
        if stale_start <= stale_end:
            (
                self.service.spreadsheets()
                .values()
                .clear(
                    spreadsheetId=self.spreadsheet_id,
                    range=f"'Percentage'!A{stale_start}:H{stale_end}",
                    body={},
                )
                .execute()
            )


def column_name(zero_based_index: int) -> str:
    number = zero_based_index + 1
    letters = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters
