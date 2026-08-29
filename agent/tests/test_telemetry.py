"""Byte accounting, where the wrong design silently produces wrong numbers.

The two cases that matter are both about counters that go backwards: a
container restarting resets its own, and a host-native unit's sockets close and
take theirs with them. Getting either wrong shows up as a day with negative
traffic, or as a total that quietly loses a closed connection's bytes.
"""

from __future__ import annotations

from pathlib import Path

from boredagent.telemetry.bandwidth import (
    Counters,
    HostAccumulator,
    delta,
    socket_counters,
)
from boredagent.telemetry.store import TelemetryStore, day_key, day_start_ms

SS_TWO_SOCKETS = """\
tcp   ESTAB  0  0  10.0.0.5:44002  1.2.3.4:443   users:(("pawns-cli",pid=100,fd=7))
\t cubic wscale:7,7 rto:204 bytes_sent:1000 bytes_acked:900 bytes_received:5000
tcp   ESTAB  0  0  10.0.0.5:44003  5.6.7.8:443   users:(("pawns-cli",pid=100,fd=8))
\t cubic wscale:7,7 rto:204 bytes_sent:2000 bytes_acked:2000 bytes_received:7000
tcp   ESTAB  0  0  10.0.0.5:44004  9.9.9.9:443   users:(("other",pid=999,fd=3))
\t cubic bytes_sent:9999 bytes_acked:9999 bytes_received:9999
"""

SS_ONE_GONE = """\
tcp   ESTAB  0  0  10.0.0.5:44003  5.6.7.8:443   users:(("pawns-cli",pid=100,fd=8))
\t cubic wscale:7,7 rto:204 bytes_sent:2500 bytes_acked:2500 bytes_received:9000
"""


class TestSocketParsing:
    def test_only_this_unit_s_sockets_are_counted(self):
        parsed = socket_counters({100}, SS_TWO_SOCKETS)
        assert parsed is not None
        assert len(parsed) == 2
        # The socket belonging to pid 999 is another service's traffic.
        assert all("9.9.9.9" not in key for key in parsed)

    def test_bytes_acked_is_preferred_over_bytes_sent(self):
        parsed = socket_counters({100}, SS_TWO_SOCKETS)
        first = parsed["10.0.0.5:44002->1.2.3.4:443"]
        # acked (900), not sent (1000): what the peer confirmed is the closer
        # measure of what actually crossed the link.
        assert first == (5000, 900)

    def test_nothing_to_read_is_unknown_rather_than_zero(self):
        assert socket_counters({100}, "") is None
        assert socket_counters(set(), SS_TWO_SOCKETS) is None

    def test_a_running_unit_holding_no_sockets_is_a_real_zero(self):
        parsed = socket_counters({4242}, SS_TWO_SOCKETS)
        assert parsed == {}


class TestHostAccumulator:
    def test_a_closed_socket_keeps_the_bytes_it_contributed(self):
        # This is the bug worth having a test for: summing live sockets and
        # delta-ing the sum would read the closed connection as the machine
        # un-sending 900 bytes.
        acc = HostAccumulator()
        acc.update(socket_counters({100}, SS_TWO_SOCKETS))
        assert (acc.rx, acc.tx) == (12000, 2900)

        acc.update(socket_counters({100}, SS_ONE_GONE))
        # The remaining socket moved 2000 more received and 500 more acked; the
        # one that closed neither adds nor subtracts.
        assert (acc.rx, acc.tx) == (14000, 3400)

    def test_totals_never_go_down(self):
        acc = HostAccumulator()
        acc.update({"a": (5000, 5000)})
        acc.update({})
        acc.update({"a": (10, 10)})  # the key was reused by a new connection
        assert acc.rx >= 5000
        assert acc.tx >= 5000

    def test_a_new_socket_starts_from_zero_not_from_a_jump(self):
        acc = HostAccumulator()
        acc.update({"a": (100, 100)})
        acc.update({"a": (100, 100), "b": (7, 7)})
        assert (acc.rx, acc.tx) == (107, 107)

    def test_the_snapshot_is_always_marked_partial(self):
        acc = HostAccumulator()
        acc.update({"a": (1, 1)})
        assert acc.snapshot().partial is True


class TestDelta:
    def test_the_first_reading_contributes_nothing(self):
        assert delta(Counters(100, 100, False), None) == Counters(0, 0, False)

    def test_an_ordinary_step(self):
        assert delta(Counters(150, 120, False), Counters(100, 100, False)) == Counters(50, 20, False)

    def test_a_container_restart_rebaselines_instead_of_going_negative(self):
        # Docker resets a container's counters when it restarts. Reporting the
        # negative difference would show a day with minus several gigabytes.
        step = delta(Counters(10, 10, False), Counters(5_000_000, 5_000_000, False))
        assert step == Counters(10, 10, False)
        assert step.rx >= 0 and step.tx >= 0

    def test_unknown_stays_unknown(self):
        assert delta(None, Counters(1, 1, False)) is None


class TestStore:
    def test_a_row_lands_in_the_day_it_is_stamped_with(self, tmp_path: Path):
        store = TelemetryStore(tmp_path, raw_days=7, daily_days=400)
        moment = 1_756_425_600_000  # 2025-08-29T00:00:00Z
        store.add_daily([{"ts": moment, "scope": "host"}])
        assert store.daily.days() == [day_key(moment)]

    def test_reading_a_window_skips_days_outside_it(self, tmp_path: Path):
        store = TelemetryStore(tmp_path, raw_days=7, daily_days=400)
        day = 86_400_000
        base = 1_756_425_600_000
        for offset in range(5):
            store.add_daily([{"ts": base + offset * day, "n": offset}])
        rows = store.daily.read(since_ms=base + 2 * day, until_ms=base + 3 * day + 1000)
        assert [row["n"] for row in rows] == [2, 3]

    def test_a_torn_line_does_not_hide_the_rest_of_the_day(self, tmp_path: Path):
        store = TelemetryStore(tmp_path, raw_days=7, daily_days=400)
        moment = 1_756_425_600_000
        store.add_daily([{"ts": moment, "n": 1}])
        path = tmp_path / "daily" / f"{day_key(moment)}.jsonl"
        with open(path, "a", encoding="utf-8") as handle:
            handle.write('{"ts":1,"n":2')  # a crash mid-append
        rows = store.daily.read()
        assert [row["n"] for row in rows] == [1]

    def test_sweep_drops_days_past_retention_and_keeps_the_rest(self, tmp_path: Path):
        store = TelemetryStore(tmp_path, raw_days=2, daily_days=400)
        now = 1_756_425_600_000
        day = 86_400_000
        store.add_sample({"ts": now - 10 * day})
        store.add_sample({"ts": now})
        assert len(store.samples.days()) == 2
        store.samples.sweep(now_ms=now)
        assert len(store.samples.days()) == 1

    def test_day_key_and_day_start_round_trip(self):
        moment = 1_756_425_600_000
        assert day_start_ms(day_key(moment)) == moment
