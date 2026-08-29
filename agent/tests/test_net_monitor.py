"""The reachability rules, which are asymmetric on purpose.

Online needs a majority of the window; offline needs the *whole* window. That
asymmetry is the reason the ping pool has seven entries across four operators:
one of them blocking ICMP has to look different from the internet being down.
"""

from __future__ import annotations

from boredagent.config import NetConfig, TelemetryConfig
from boredagent.net.monitor import NetEvent, NetMonitor
from boredagent.net.probes import IpSample, PingSample, parse_ipv4, parse_rtt


def monitor(**overrides):
    events: list[NetEvent] = []
    config = NetConfig(**{"offline_window": 5, "history_size": 100, **overrides})
    return NetMonitor(config, TelemetryConfig(), on_event=events.append), events


def feed(mon, results, target="1.1.1.1", start=1_000):
    """results: iterable of latency-or-None, one per tick."""
    for index, latency in enumerate(results):
        ok = latency is not None
        mon._record_ping(
            PingSample(start + index * 1000, target, ok, latency, None if ok else "no reply")
        )


class TestParsing:
    def test_rtt_from_the_usual_shapes(self):
        assert parse_rtt("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms") == 12.3
        assert parse_rtt("time<1 ms") == 1.0
        assert parse_rtt("no timing here") is None

    def test_an_ipv4_out_of_dig_output(self):
        assert parse_ipv4('"203.0.113.10"\n') == "203.0.113.10"
        assert parse_ipv4("203.0.113.10") == "203.0.113.10"
        # A TXT answer that is not an address, and an IPv6 answer, are both
        # "no IPv4 here" rather than something to guess at.
        assert parse_ipv4("2001:db8::1") is None
        assert parse_ipv4("some.host.name.") is None
        assert parse_ipv4("") is None


class TestOnlineOffline:
    def test_a_majority_makes_it_online(self):
        mon, _ = monitor()
        feed(mon, [10, 10, None, 10, 10])
        assert mon.online is True

    def test_the_whole_window_has_to_fail_before_it_is_offline(self):
        mon, _ = monitor()
        feed(mon, [10, 10, 10, 10, 10])
        assert mon.online is True
        # Four of five failing is not enough - this is one operator having a
        # bad minute, and the pool is about to ask somebody else.
        feed(mon, [None, None, None, None], start=10_000)
        assert mon.online is True
        feed(mon, [None], start=20_000)
        assert mon.online is False

    def test_one_reply_does_not_clear_an_outage_on_its_own(self):
        mon, _ = monitor()
        feed(mon, [None] * 5)
        assert mon.online is False
        # One success in a window of five is not a majority, so the state holds
        # rather than flapping on a single packet.
        feed(mon, [10], start=10_000)
        assert mon.online is False

    def test_link_events_fire_on_the_transition_only(self):
        mon, events = monitor()
        feed(mon, [10] * 5)
        assert [e.type for e in events] == []
        feed(mon, [None] * 5, start=10_000)
        assert [e.type for e in events] == ["link_down"]
        feed(mon, [10] * 5, start=20_000)
        assert [e.type for e in events] == ["link_down", "link_up"]

    def test_the_first_reading_does_not_announce_itself(self):
        # An agent that has just started has not seen the link "come up" - it
        # has merely looked for the first time, and saying otherwise would put
        # a link_up in the incident log on every restart.
        mon, events = monitor()
        feed(mon, [10] * 5)
        assert events == []
        assert mon.online is True


class TestPublicIp:
    def test_a_failed_tick_keeps_the_last_known_address(self):
        mon, _ = monitor()
        mon._record_ip(IpSample(1000, "google_ns1", "203.0.113.10", True))
        mon._record_ip(IpSample(2000, "opendns_1", None, False, "timed out"))
        assert mon.public_ip == "203.0.113.10"
        assert mon.status()["lastIpError"] == "timed out"

    def test_a_change_is_announced_with_both_addresses(self):
        mon, events = monitor()
        mon._record_ip(IpSample(1000, "google_ns1", "203.0.113.10", True))
        assert events == []  # the first address is not a change
        mon._record_ip(IpSample(2000, "akamai", "198.51.100.7", True))
        assert len(events) == 1
        assert events[0].type == "ip_changed"
        assert events[0].data["from"] == "203.0.113.10"
        assert events[0].data["to"] == "198.51.100.7"

    def test_the_same_address_from_a_different_source_is_not_a_change(self):
        mon, events = monitor()
        mon._record_ip(IpSample(1000, "google_ns1", "203.0.113.10", True))
        mon._record_ip(IpSample(2000, "akamai", "203.0.113.10", True))
        assert events == []


class TestLatencySpikes:
    def test_a_sustained_episode_is_one_event_with_a_peak(self):
        mon, events = monitor()
        feed(mon, [10] * 20)
        feed(mon, [500, 600, 700], start=100_000)
        assert [e.type for e in events] == []  # still open
        feed(mon, [10], start=200_000)
        spikes = [e for e in events if e.type == "latency_spike"]
        assert len(spikes) == 1
        assert spikes[0].data["peakMs"] == 700
        assert spikes[0].data["samples"] == 3

    def test_a_single_slow_packet_is_not_an_episode(self):
        mon, events = monitor()
        feed(mon, [10] * 20)
        feed(mon, [900], start=100_000)
        feed(mon, [10], start=200_000)
        assert [e for e in events if e.type == "latency_spike"] == []

    def test_a_slow_link_does_not_report_itself_as_spiking(self):
        # A 200ms satellite link is slow, not spiking. The floor is what stops
        # the multiplier turning a consistently high baseline into an incident.
        mon, events = monitor()
        feed(mon, [200] * 30)
        feed(mon, [210, 205, 215], start=100_000)
        feed(mon, [200], start=200_000)
        assert [e for e in events if e.type == "latency_spike"] == []


class TestStatusAndHistory:
    def test_status_names_the_target_of_the_last_probe(self):
        mon, _ = monitor()
        mon._record_ping(PingSample(1000, "8.8.8.8", True, 11.0))
        status = mon.status()
        assert status["lastPingTarget"] == "8.8.8.8"
        assert status["latencyMs"] == 11.0
        assert status["lastByTarget"]["8.8.8.8"]["ok"] is True

    def test_history_is_bounded_and_newest_last(self):
        mon, _ = monitor(history_size=10)
        feed(mon, list(range(1, 31)))
        rows = mon.history("ping", limit=100)
        assert len(rows) == 10
        assert rows[-1]["latencyMs"] == 30
