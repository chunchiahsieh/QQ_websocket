"""The five baccarat roads used by the existing Render card contract."""

from __future__ import annotations

import re


def _place(winners: list[int]) -> tuple[list[dict], list[int]]:
    marks: list[dict] = []
    lengths: list[int] = []
    occupied: set[tuple[int, int]] = set()
    start = logical = -1
    previous: dict | None = None
    tail = False
    pending_ties = 0
    for index, winner in enumerate(winners):
        if winner == 3:
            if previous is not None:
                previous["ties"] += 1
            else:
                pending_ties += 1
            continue
        changed = previous is None or previous["winner"] != winner
        if changed:
            logical += 1
            lengths.append(0)
            start += 1
            while (start, 0) in occupied:
                start += 1
            col, row, tail = start, 0, False
        else:
            col, row = previous["col"], previous["row"]
            if not tail and row < 5 and (col, row + 1) not in occupied:
                row += 1
            else:
                tail = True
                col += 1
                while (col, row) in occupied:
                    col += 1
        mark = {"col": col, "row": row, "winner": winner, "ties": pending_ties,
                "logical_col": logical, "logical_row": lengths[logical], "index": index}
        lengths[logical] += 1
        pending_ties = 0
        marks.append(mark)
        occupied.add((col, row))
        previous = mark
    return marks, lengths


def _encode(marks: list[dict], code) -> str:
    if not marks:
        return ""
    cols = [[""] * 6 for _ in range(max(m["col"] for m in marks) + 1)]
    for mark in marks:
        cols[mark["col"]][mark["row"]] = code(mark)
    return "#".join(",".join(col) for col in cols)


def _normalize(winners: list[int], point_code) -> dict:
    recent = winners[-36:]
    marks, lengths = _place(winners)

    def derived(gap: int) -> str:
        colors: list[int] = []
        for mark in marks:
            c, r = mark["logical_col"], mark["logical_row"]
            if r == 0 and c - gap - 1 >= 0:
                colors.append(1 if lengths[c - 1] == lengths[c - gap - 1] else 2)
            elif r > 0 and c - gap >= 0:
                length = lengths[c - gap]
                colors.append(1 if (length > r) == (length > r - 1) else 2)
        return _encode(_place(colors)[0], lambda m: str(m["winner"]))

    return {"beadPlate": "#".join("".join("0" + str(x) for x in recent[i:i+6])
                                    for i in range(0, len(recent), 6)),
            "aiOutcomes": [str(x) for x in winners],
            "bigRoad": _encode(marks, point_code),
            "bigEyeRoad": derived(1), "smallRoad": derived(2), "cockroachRoad": derived(3),
            "banker": str(winners.count(2)), "player": str(winners.count(1)),
            "tie": str(winners.count(3))}


def dg_roads(raw: list[str]) -> dict:
    winners = []
    for item in reversed(raw):
        try:
            code = int(item.split("#")[-1])
        except ValueError:
            continue
        if 1 <= code <= 12:
            winners.append(2 if code <= 4 else 1 if code <= 8 else 3)
    return _normalize(winners, lambda m: f'{min(9, m["ties"])}?0{m["winner"]}')


_AB_RESULT = re.compile(r"^[0-6][0-9]{2}[0-6][A-Za-z0-9]{8}$")


def ab_roads(raw: list[str]) -> dict:
    results = [item for item in raw if _AB_RESULT.fullmatch(item)]
    winners = [2 if item[0] in "15" else 1 if item[0] in "26" else 3 for item in results]
    return _normalize(winners, lambda m: f'{min(9, m["ties"])}{results[m["index"]][2 if m["winner"] == 1 else 1]}0{m["winner"]}')
