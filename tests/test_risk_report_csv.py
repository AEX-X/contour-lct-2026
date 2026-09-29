"""CSV exports of the risk report carry exactly the xlsx rows."""
import csv
import io
from datetime import datetime

import pytest

from tests.test_risk_report import PERIOD, _export, _xlsx_rows, seeded  # noqa: F401 -- seeded is a fixture

BOM = b"\xef\xbb\xbf"


def _expected_text(value, decimal_separator: str) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:.4f}".rstrip("0").rstrip(".").replace(".", decimal_separator)
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value)


async def _compare_with_xlsx(report_format: str, delimiter: str, decimal_separator: str, seeded: dict) -> dict[str, list[str]]:
    xlsx = await _export("manager", "manager123", {**PERIOD, "format": "xlsx"})
    response = await _export("manager", "manager123", {**PERIOD, "format": report_format})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert 'filename="risks_2045-03-01_2045-03-31.csv"' in response.headers["content-disposition"]
    assert response.content.startswith(BOM), "Excel needs the UTF-8 BOM to read Cyrillic"

    header, xlsx_rows = _xlsx_rows(xlsx.content)
    parsed = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline=""), delimiter=delimiter))
    assert parsed[0] == header
    csv_rows = {row[0]: row for row in parsed[1:]}
    assert set(csv_rows) == set(xlsx_rows), "same risks in both formats"
    for risk_id, xlsx_row in xlsx_rows.items():
        assert csv_rows[risk_id] == [_expected_text(v, decimal_separator) for v in xlsx_row], f"row {risk_id} differs"
    return csv_rows


@pytest.mark.asyncio
async def test_csv_semicolon_matches_xlsx(seeded: dict) -> None:  # noqa: F811
    rows = await _compare_with_xlsx("csv_semicolon", ";", ",", seeded)
    rejected = rows[seeded["ids"]["rejected"]]
    assert "0,72" in rejected, "decimal comma for Russian Excel"
    assert "Объект А; корпус \"1\"" in rejected, "value with ; and quotes survives"
    assert "пыль, строка\nвторая" in rejected, "value with a line break survives"


@pytest.mark.asyncio
async def test_csv_semicolon_raw_bytes_use_semicolons(seeded: dict) -> None:  # noqa: F811
    response = await _export("manager", "manager123", {**PERIOD, "format": "csv_semicolon"})
    first_line = response.content.decode("utf-8-sig").split("\r\n")[0]
    assert first_line == ";".join(
        ["Риск", "Объект", "Название объекта", "Тип риска", "Вероятность", "Уровень", "Время прогноза (МСК)",
         "Решение", "Причина отклонения", "Комментарий", "Заявка"]
    )


@pytest.mark.asyncio
async def test_csv_comma_matches_xlsx(seeded: dict) -> None:  # noqa: F811
    rows = await _compare_with_xlsx("csv_comma", ",", ".", seeded)
    rejected = rows[seeded["ids"]["rejected"]]
    assert "0.72" in rejected, "decimal point for the classic CSV"
    assert "пыль, строка\nвторая" in rejected, "value with a comma and a line break survives"
    assert "Объект А; корпус \"1\"" in rejected, "value with quotes survives"


@pytest.mark.asyncio
async def test_csv_comma_is_readable_by_a_standard_dict_reader(seeded: dict) -> None:  # noqa: F811
    response = await _export("manager", "manager123", {**PERIOD, "format": "csv_comma"})
    records = {r["Риск"]: r for r in csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"), newline=""))}
    acknowledged = records[seeded["ids"]["acknowledged"]]
    assert acknowledged["Заявка"] == seeded["work_order"]
    assert float(acknowledged["Вероятность"]) == pytest.approx(0.9)
