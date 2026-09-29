namespace CollectorDesktop;

// Matches lib/ab-card.ts baccaratRoads, including the point digit in each
// big-road mark. AB's chronological result strings are not DG result codes.
internal static class AbRoadNormalizer
{
    readonly record struct Mark(int Col, int Row, int Winner, int Ties, int LogicalCol, int LogicalRow, int Index);

    internal static Dictionary<string, object?> Normalize(IReadOnlyList<string> results)
    {
        var winners = results.Select(result => "15".Contains(result[0]) ? 2 : "26".Contains(result[0]) ? 1 : 3).ToArray();
        var bead = string.Join("#", Enumerable.Range(0, (winners.Length + 5) / 6)
            .Select(col => string.Concat(winners.Skip(col * 6).Take(6).Select(winner => "0" + winner))));
        var (marks, lengths) = Place(winners);
        string Derived(int gap)
        {
            var colors = new List<int>();
            foreach (var mark in marks)
            {
                var c = mark.LogicalCol;
                var r = mark.LogicalRow;
                if (r == 0)
                {
                    if (c - gap - 1 >= 0) colors.Add(lengths[c - 1] == lengths[c - gap - 1] ? 1 : 2);
                }
                else if (c - gap >= 0)
                {
                    var length = lengths[c - gap];
                    colors.Add((length > r) == (length > r - 1) ? 1 : 2);
                }
            }
            return Encode(Place(colors).Marks, mark => mark.Winner.ToString());
        }

        return new Dictionary<string, object?> {
            ["beadPlate"] = bead,
            ["bigRoad"] = Encode(marks, mark => $"{Math.Min(9, mark.Ties)}{results[mark.Index][mark.Winner == 1 ? 2 : 1]}0{mark.Winner}"),
            ["bigEyeRoad"] = Derived(1),
            ["smallRoad"] = Derived(2),
            ["cockroachRoad"] = Derived(3),
            ["banker"] = winners.Count(winner => winner == 2).ToString(),
            ["player"] = winners.Count(winner => winner == 1).ToString(),
            ["tie"] = winners.Count(winner => winner == 3).ToString(),
        };
    }

    static (List<Mark> Marks, List<int> Lengths) Place(IReadOnlyList<int> results)
    {
        var marks = new List<Mark>();
        var lengths = new List<int>();
        var occupied = new HashSet<(int Col, int Row)>();
        var start = -1;
        var logical = -1;
        Mark? previous = null;
        var tail = false;
        var pendingTies = 0;
        for (var index = 0; index < results.Count; index++)
        {
            var winner = results[index];
            if (winner == 3)
            {
                if (previous is { } last)
                {
                    var withTie = last with { Ties = last.Ties + 1 };
                    marks[^1] = withTie;
                    previous = withTie;
                }
                else pendingTies++;
                continue;
            }
            int col, row;
            var changed = previous is null || previous.Value.Winner != winner;
            if (changed)
            {
                logical++;
                lengths.Add(0);
                start++;
                while (occupied.Contains((start, 0))) start++;
                col = start;
                row = 0;
                tail = false;
            }
            else
            {
                col = previous!.Value.Col;
                row = previous.Value.Row;
                if (!tail && row < 5 && !occupied.Contains((col, row + 1))) row++;
                else
                {
                    tail = true;
                    col++;
                    while (occupied.Contains((col, row))) col++;
                }
            }
            var mark = new Mark(col, row, winner, pendingTies, logical, lengths[logical]++, index);
            pendingTies = 0;
            marks.Add(mark);
            occupied.Add((col, row));
            previous = mark;
        }
        return (marks, lengths);
    }

    static string Encode(IReadOnlyList<Mark> marks, Func<Mark, string> code)
    {
        if (marks.Count == 0) return "";
        var columns = Enumerable.Range(0, marks.Max(mark => mark.Col) + 1)
            .Select(_ => Enumerable.Repeat("", 6).ToArray()).ToArray();
        foreach (var mark in marks) columns[mark.Col][mark.Row] = code(mark);
        return string.Join("#", columns.Select(column => string.Join(",", column)));
    }
}
