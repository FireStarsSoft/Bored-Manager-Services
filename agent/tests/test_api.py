"""The HTTP contract, including the refusals.

The auth tests matter most: every route but health has to be closed, and the
easy way to get that wrong is to add a route later and forget. These check the
shape of the whole surface rather than one route at a time.
"""

from __future__ import annotations

import pytest

from conftest import TOKEN


class TestAuth:
    def test_health_is_open_and_says_almost_nothing(self, client):
        del client.headers["authorization"]
        response = client.get("/v1/health")
        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is True
        assert body["service"] == "boredagent"
        # It must not leak anything about what is installed or configured: a
        # fleet manager only needs "an agent is here, at this version".
        assert set(body) == {"ok", "service", "version"}

    @pytest.mark.parametrize(
        "method,path",
        [
            ("get", "/v1/info"),
            ("get", "/v1/templates"),
            ("get", "/v1/instances"),
            ("get", "/v1/net/status"),
            ("get", "/v1/net/history"),
            ("get", "/v1/stats/current"),
            ("get", "/v1/stats/daily"),
            ("get", "/v1/stats/events"),
            ("get", "/v1/live/sse"),
            ("put", "/v1/templates/anything"),
            ("delete", "/v1/templates/anything"),
        ],
    )
    def test_every_other_route_needs_a_token(self, client, method, path):
        del client.headers["authorization"]
        # httpx's get/delete take no body, so only put carries one.
        response = (
            client.put(path, json={}) if method == "put" else getattr(client, method)(path)
        )
        assert response.status_code == 401, f"{method} {path} answered {response.status_code}"

    def test_a_wrong_token_is_401_not_403(self, client):
        client.headers.update({"authorization": "Bearer not-the-token"})
        assert client.get("/v1/templates").status_code == 401

    def test_a_token_may_come_from_the_query_string(self, client):
        del client.headers["authorization"]
        assert client.get(f"/v1/templates?token={TOKEN}").status_code == 200


class TestTemplates:
    def test_the_library_starts_empty(self, client):
        body = client.get("/v1/templates").json()
        assert body["templates"] == []
        assert body["problems"] == {}

    def test_importing_a_seed_template(self, client, honeygain_doc):
        response = client.put("/v1/templates/honeygain", json=honeygain_doc)
        assert response.status_code == 200, response.text
        assert response.json()["ok"] is True

        listed = client.get("/v1/templates").json()["templates"]
        assert [t["id"] for t in listed] == ["honeygain"]
        assert listed[0]["units"] == ["honeygain"]

    def test_a_template_never_answers_with_values(self, client, honeygain_doc):
        client.put("/v1/templates/honeygain", json=honeygain_doc)
        client.post(
            "/v1/instances/honeygain/install",
            json={"email": "a@b.c", "password": "hunter2", "device": "nas"},
        )
        body = client.get("/v1/templates/honeygain").json()
        rendered = str(body)
        # The schema is there, the secret is not.
        assert "password" in rendered
        assert "hunter2" not in rendered
        assert body["hasCredentials"] is True

    def test_a_malformed_template_is_422_with_every_problem(self, client):
        response = client.put(
            "/v1/templates/broken",
            json={"id": "broken", "displayName": "B", "kind": "service",
                  "service": {"units": [{"unit": "b.service", "primary": True,
                                         "install": [{"op": "script", "body": "x"}]}]}},
        )
        assert response.status_code == 422
        assert any("privileged" in f["message"] for f in response.json()["findings"])

    def test_a_template_sent_under_the_wrong_id_is_refused(self, client, honeygain_doc):
        response = client.put("/v1/templates/something-else", json=honeygain_doc)
        assert response.status_code == 422
        assert any("calls itself" in f["message"] for f in response.json()["findings"])

    def test_deleting_a_template_leaves_what_it_installed_running(self, client, honeygain_doc, docker):
        client.put("/v1/templates/honeygain", json=honeygain_doc)
        client.post(
            "/v1/instances/honeygain/install",
            json={"email": "a@b.c", "password": "p", "device": "nas"},
        )
        assert "honeygain" in docker.containers
        assert client.delete("/v1/templates/honeygain").status_code == 200
        # Deleting the description of a service must not be a destructive act.
        assert "honeygain" in docker.containers

    def test_deleting_something_that_is_not_there(self, client):
        assert client.delete("/v1/templates/ghost").status_code == 404


class TestInstances:
    @pytest.fixture(autouse=True)
    def _installed(self, client, honeygain_doc):
        client.put("/v1/templates/honeygain", json=honeygain_doc)

    def test_install_starts_the_container_with_substituted_arguments(self, client, docker):
        response = client.post(
            "/v1/instances/honeygain/install",
            json={"email": "a@b.c", "password": "s3cret", "device": "my nas"},
        )
        assert response.status_code == 200, response.text
        args = docker.containers["honeygain"]["args"]
        assert "a@b.c" in args
        assert "s3cret" in args
        # A value containing a space stays one argument. This is the property
        # that stops a field being able to add a second argument.
        assert "my nas" in args
        # -tou-accept -email X -pass Y -device Z: seven elements, and a value
        # holding a space did not become an eighth.
        assert len(args) == 7

    def test_a_missing_required_value_is_422_and_starts_nothing(self, client, docker):
        response = client.post("/v1/instances/honeygain/install", json={"email": "a@b.c"})
        assert response.status_code == 422
        assert "Password" in response.json()["message"]
        assert docker.containers == {}

    def test_lifecycle_verbs(self, client, docker):
        client.post(
            "/v1/instances/honeygain/install",
            json={"email": "a@b.c", "password": "p", "device": "nas"},
        )
        assert client.post("/v1/instances/honeygain/stop").status_code == 200
        assert client.get("/v1/instances/honeygain").json()["state"] == "stopped"
        assert client.post("/v1/instances/honeygain/start").status_code == 200
        assert client.get("/v1/instances/honeygain").json()["state"] == "running"
        assert client.post("/v1/instances/honeygain/restart").status_code == 200

    def test_an_unknown_verb_is_refused(self, client):
        assert client.post("/v1/instances/honeygain/destroy").status_code == 400

    def test_uninstall_keeps_credentials_unless_asked(self, client, docker):
        client.post(
            "/v1/instances/honeygain/install",
            json={"email": "a@b.c", "password": "p", "device": "nas"},
        )
        client.post("/v1/instances/honeygain/uninstall")
        assert docker.containers == {}
        assert client.get("/v1/templates/honeygain").json()["hasCredentials"] is True

        client.post("/v1/instances/honeygain/uninstall?forget=1")
        assert client.get("/v1/templates/honeygain").json()["hasCredentials"] is False

    def test_an_unknown_template_is_404(self, client):
        assert client.get("/v1/instances/nope").status_code == 404
        assert client.post("/v1/instances/nope/start").status_code == 404


class TestLogs:
    @pytest.fixture(autouse=True)
    def _installed(self, client, packetstream_doc, docker):
        client.put("/v1/templates/packetstream", json=packetstream_doc)
        client.post("/v1/instances/packetstream/install", json={"cid": "SECRETCID"})
        docker.log_lines["psclient"] = ["starting", "CID=SECRETCID accepted", "working"]
        docker.log_lines["watchtower"] = ["watching"]

    def test_the_primary_unit_is_the_default(self, client):
        body = client.get("/v1/instances/packetstream/logs").json()
        assert body["unit"] == "psclient"

    def test_another_unit_of_the_same_template_is_readable(self, client):
        body = client.get("/v1/instances/packetstream/logs?unit=watchtower").json()
        assert body["unit"] == "watchtower"
        assert body["lines"] == ["watching"]

    def test_a_unit_outside_the_template_is_404_not_403(self, client, docker):
        # 403 would confirm the container exists, turning this route into a way
        # to enumerate what is running on the machine.
        docker.log_lines["someone-elses-db"] = ["secret"]
        assert client.get("/v1/instances/packetstream/logs?unit=someone-elses-db").status_code == 404

    def test_secrets_are_redacted_out_of_log_lines(self, client):
        lines = client.get("/v1/instances/packetstream/logs").json()["lines"]
        joined = "\n".join(lines)
        assert "SECRETCID" not in joined
        assert "[redacted]" in joined

    def test_tail_is_capped_by_configuration(self, client):
        body = client.get("/v1/instances/packetstream/logs?tail=999999").json()
        assert body["tail"] == 5000


class TestNetAndStats:
    def test_status_before_any_probe_has_run(self, client):
        body = client.get("/v1/net/status").json()
        # Nothing has been measured yet, so `online` is null rather than false:
        # "we have not looked" is not "there is no internet".
        assert body["online"] is None
        assert body["publicIp"] is None

    def test_history_kinds(self, client):
        assert client.get("/v1/net/history?kind=ping").status_code == 200
        assert client.get("/v1/net/history?kind=ip").status_code == 200
        assert client.get("/v1/net/history?kind=nonsense").status_code == 400

    def test_stats_report_themselves_as_off_when_disabled(self, client):
        assert client.get("/v1/stats/current").json() == {"enabled": False}
        assert client.get("/v1/stats/daily").json()["rows"] == []
