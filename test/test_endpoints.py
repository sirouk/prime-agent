"""Unit tests for helper/prime-agent-endpoints. Run: python3 -m unittest discover -s test -v"""

import contextlib
import importlib.machinery
import importlib.util
import hashlib
import io
import json
import os
import stat
import sys
import tempfile
import time
import unittest
import unittest.mock
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mock_openai import MockServer  # noqa: E402

_loader = importlib.machinery.SourceFileLoader("endpoints_helper", os.path.join(HERE, "..", "helper", "prime-agent-endpoints"))
_spec = importlib.util.spec_from_loader("endpoints_helper", _loader)
helper = importlib.util.module_from_spec(_spec)
_loader.exec_module(helper)


def fixture(name: str) -> List[Dict[str, Any]]:
    with open(os.path.join(HERE, "fixtures", name), encoding="utf-8") as handle:
        return json.load(handle)["data"]


CHUTES = fixture("catalog.json")
OPENROUTER = fixture("openrouter-catalog.json")


def endpoint(**overrides: Any) -> Dict[str, Any]:
    return {"id": "local", "name": "Local", "baseUrl": "http://127.0.0.1:9/v1", "enabled": True, **overrides}


class HelperTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.agent_dir = os.path.join(self.directory.name, "agent")
        self.env_patch = unittest.mock.patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": self.agent_dir})
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        for name in ("LOCAL_API_KEY", "MY_GPU_API_KEY", "GPU_API_KEY"):
            os.environ.pop(name, None)

    def path(self, *parts: str) -> str:
        return os.path.join(self.agent_dir, *parts)

    def read(self, *parts: str) -> Any:
        with open(self.path(*parts), encoding="utf-8") as handle:
            return json.load(handle)

    def write(self, text: str, *parts: str) -> None:
        os.makedirs(os.path.dirname(self.path(*parts)), exist_ok=True)
        with open(self.path(*parts), "w", encoding="utf-8") as handle:
            handle.write(text)

    def save_endpoints(self, *endpoints: Dict[str, Any]) -> None:
        self.write(json.dumps({"endpoints": list(endpoints)}), "endpoints.json")

    def save_cache(self, endpoint_id: str, *entries: Dict[str, Any]) -> None:
        self.write(json.dumps({"refreshedAt": 1, "data": list(entries)}), "endpoints", f"{endpoint_id}.models.json")

    def run_cli(self, *argv: str, stdin: str = "") -> Tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), unittest.mock.patch.object(
            sys, "stdin", io.StringIO(stdin)
        ):
            try:
                code = helper.main(list(argv))
            except SystemExit as exit_:
                code = int(exit_.code or 0)
        return code, out.getvalue(), err.getvalue()

    def mock(self, **options: Any) -> MockServer:
        server = MockServer(**options).start()
        self.addCleanup(server.stop)
        return server

    def providers(self) -> Dict[str, Any]:
        return self.read("models.json")["providers"]


class ModelMapping(HelperTestCase):
    def test_reads_chutes_context_output_image_input_and_capabilities(self) -> None:
        kimi = next(entry for entry in CHUTES if entry["id"] == "moonshotai/Kimi-K3-TEE")
        self.assertEqual(
            helper.to_model(kimi, endpoint()),
            {
                "id": "moonshotai/Kimi-K3-TEE",
                "name": "moonshotai/Kimi-K3-TEE",
                "reasoning": True,
                "input": ["text", "image"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": 1048576,
                "maxTokens": 65535,
            },
        )
        no_tools = next(entry for entry in CHUTES if entry["id"] == "unsloth/Mistral-Nemo-Instruct-2407-TEE")
        self.assertIsNotNone(helper.to_model(no_tools, endpoint()), "a model with no reported capabilities is kept")

    def test_reads_openrouter_and_drops_models_listed_without_tools(self) -> None:
        rich, without_tools = OPENROUTER[0], OPENROUTER[1]
        model = helper.to_model(rich, endpoint())
        self.assertEqual(model["name"], rich["name"])
        self.assertEqual(model["contextWindow"], rich["context_length"])
        self.assertEqual(model["maxTokens"], rich["top_provider"]["max_completion_tokens"])
        self.assertEqual(model["input"], ["text", "image"])
        self.assertTrue(model["reasoning"])
        self.assertIsNone(helper.to_model(without_tools, endpoint()))

    def test_reads_vllm_max_model_len_and_never_exceeds_it_for_output(self) -> None:
        limits = [helper.to_model({"id": "a", "max_model_len": n}, endpoint()) for n in (32768, 8192)]
        self.assertEqual([(m["contextWindow"], m["maxTokens"]) for m in limits], [(32768, 16384), (8192, 8192)])

    def test_reads_a_gateways_display_name_output_limit_and_modalities(self) -> None:
        entry = {
            "id": "claude-sonnet-5",
            "display_name": "Claude Sonnet 5",
            "context_length": 1000000,
            "max_output_tokens": 128000,
            "input_modalities": ["text", "image"],
            "reasoning": {"supported": True, "effort_control": True, "levels": ["low", "medium", "high"]},
        }
        model = helper.to_model(entry, endpoint())
        self.assertEqual(
            (model["name"], model["contextWindow"], model["maxTokens"], model["input"], model["reasoning"]),
            ("Claude Sonnet 5", 1000000, 128000, ["text", "image"], True),
        )
        self.assertEqual(helper.to_model({**entry, "name": "Given Name"}, endpoint())["name"], "Given Name")

    def test_falls_back_to_the_endpoints_limits_then_prime_agents_defaults(self) -> None:
        plain = {"id": "llama3.1:8b", "object": "model"}
        defaults = helper.to_model(plain, endpoint())
        self.assertEqual((defaults["contextWindow"], defaults["maxTokens"], defaults["reasoning"]), (128000, 16384, False))
        tuned = helper.to_model(plain, endpoint(contextWindow=32000, maxTokens=4096))
        self.assertEqual((tuned["contextWindow"], tuned["maxTokens"]), (32000, 4096))

    def test_reasoning_comes_from_what_the_endpoint_states_and_an_explicit_false_wins(self) -> None:
        self.assertTrue(helper.to_model({"id": "m", "supports_reasoning": True}, endpoint())["reasoning"])
        self.assertTrue(helper.to_model({"id": "m", "supported_features": ["tools", "reasoning"]}, endpoint())["reasoning"])
        self.assertFalse(helper.to_model({"id": "m", "supports_reasoning": False, "reasoning": True}, endpoint())["reasoning"])
        self.assertFalse(helper.to_model({"id": "deepseek-r1-thinking"}, endpoint())["reasoning"], "never from names")

    def test_listed_effort_levels_become_a_thinking_level_map(self) -> None:
        entry = {"id": "m", "supports_reasoning": True, "reasoning_effort_levels": ["low", "high", "xhigh"]}
        model = helper.to_model(entry, endpoint())
        self.assertEqual(
            model["thinkingLevelMap"],
            {"off": "none", "minimal": None, "low": "low", "medium": None, "high": "high", "xhigh": "xhigh", "max": None},
        )
        self.assertTrue(helper.provider_compat([entry])["supportsReasoningEffort"])
        always_on = helper.to_model({**entry, "reasoning_always_on": True}, endpoint())
        self.assertIsNone(always_on["thinkingLevelMap"]["off"])
        nested = helper.to_model({"id": "m", "reasoning": {"supported": True, "levels": ["medium"]}}, endpoint())
        self.assertEqual(nested["thinkingLevelMap"]["medium"], "medium")

    def test_the_provider_asks_for_the_broadly_supported_request_shape(self) -> None:
        self.assertEqual(
            helper.provider_compat([{"id": "plain"}]),
            {"supportsStore": False, "supportsDeveloperRole": False, "maxTokensField": "max_tokens"},
        )

    def test_a_server_gating_thinking_with_enable_thinking_gets_the_toggle_alone(self) -> None:
        gated = {
            "id": "m",
            "supports_reasoning": True,
            "reasoning_style": "enable_thinking_effort",
            "reasoning_effort_levels": ["low", "medium", "xhigh"],
        }
        self.assertNotIn("thinkingLevelMap", helper.to_model(gated, endpoint()))
        compat = helper.provider_compat([gated, {"id": "other"}])
        self.assertEqual(compat["thinkingFormat"], "qwen")
        self.assertNotIn("supportsReasoningEffort", compat)

    def test_where_an_endpoint_has_both_kinds_of_model_effort_levels_win(self) -> None:
        gated = {"id": "g", "supports_reasoning": True, "reasoning_style": "enable_thinking_effort"}
        effort = {"id": "e", "supports_reasoning": True, "reasoning_effort_levels": ["low"]}
        compat = helper.provider_compat([gated, effort])
        self.assertTrue(compat["supportsReasoningEffort"])
        self.assertNotIn("thinkingFormat", compat)

    def test_status_describes_only_the_loaded_models(self) -> None:
        status = {"loaded": ["a"], "supports_reasoning": True, "context_length": 188672, "ignored": 1}
        merged = helper.merge_status([{"id": "a"}, {"id": "b"}], status)
        self.assertEqual(merged[0], {"id": "a", "supports_reasoning": True, "context_length": 188672})
        self.assertEqual(merged[1], {"id": "b"})
        self.assertEqual(helper.merge_status([{"id": "a"}], {"supports_reasoning": True}), [{"id": "a"}])
        self.assertEqual(helper.merge_status([{"id": "a"}], None), [{"id": "a"}])

    def test_rejects_responses_that_are_not_a_model_list(self) -> None:
        with self.assertRaisesRegex(helper.Fail, "not an OpenAI-compatible model list"):
            helper.parse_catalog([{"id": "a"}])
        self.assertEqual(helper.parse_catalog({"data": [{"id": "a"}, {"name": "no id"}]}), [{"id": "a"}])


class SavedEndpoints(HelperTestCase):
    def test_a_missing_file_means_no_endpoints(self) -> None:
        self.assertEqual(helper.read_endpoints(), [])

    def test_names_the_file_and_the_problem_when_it_is_malformed(self) -> None:
        self.write("{ not json", "endpoints.json")
        with self.assertRaisesRegex(helper.Fail, r"endpoints\.json: "):
            helper.read_endpoints()
        for bad, message in (
            (endpoint(baseUrl="ftp://example.com"), r'endpoints\[0\]: "baseUrl" must be an http or https URL'),
            (endpoint(id="Has Spaces"), r'"id" must be lowercase'),
            (endpoint(contextWindow=0), r'"contextWindow" must be a positive whole number'),
        ):
            self.save_endpoints(bad)
            with self.assertRaisesRegex(helper.Fail, message):
                helper.read_endpoints()
        self.save_endpoints(endpoint(), endpoint())
        with self.assertRaisesRegex(helper.Fail, "used twice"):
            helper.read_endpoints()

    def test_derives_the_environment_variable_from_the_id(self) -> None:
        self.assertEqual(helper.env_var_for("my-vllm"), "MY_VLLM_API_KEY")


class ModelsJson(HelperTestCase):
    def test_writes_a_provider_per_enabled_endpoint_and_keeps_everything_else(self) -> None:
        self.write(
            '// my providers\n{\n  "providers": {\n    "ollama": {"baseUrl": "http://localhost:11434/v1", "apiKey": "x", "api": "openai-completions", "models": [{"id": "llama3"}],},\n  },\n  "other": 1\n}\n',
            "models.json",
        )
        self.save_endpoints(endpoint(), endpoint(id="off", name="Off", enabled=False))
        self.save_cache("local", {"id": "m1"})
        self.save_cache("off", {"id": "m2"})
        counts = helper.sync_models()

        document = self.read("models.json")
        self.assertEqual(counts, {"local": 1})
        self.assertEqual(document["other"], 1)
        self.assertEqual(list(document["providers"]), ["ollama", "local"])
        self.assertEqual(document["providers"]["ollama"]["models"], [{"id": "llama3"}])
        block = document["providers"]["local"]
        self.assertEqual(
            (block["baseUrl"], block["api"], block["apiKey"], [m["id"] for m in block["models"]]),
            ("http://127.0.0.1:9/v1", "openai-completions", "LOCAL_API_KEY", ["m1"]),
        )
        self.assertTrue(os.path.exists(self.path("models.json.before-endpoints")), "the original, with its comment, is kept")

    def test_disabling_or_removing_deletes_only_that_endpoints_provider(self) -> None:
        self.save_endpoints(endpoint(), endpoint(id="two", name="Two"))
        self.save_cache("local", {"id": "m1"})
        self.save_cache("two", {"id": "m2"})
        helper.sync_models()
        self.assertEqual(set(self.providers()), {"local", "two"})
        self.save_endpoints(endpoint(enabled=False), endpoint(id="two", name="Two"))
        helper.sync_models()
        self.assertEqual(set(self.providers()), {"two"})
        self.save_endpoints(endpoint(enabled=False))
        helper.sync_models(removed=("two",))
        self.assertEqual(self.providers(), {})

    def test_changes_nothing_when_there_is_nothing_to_write(self) -> None:
        self.assertEqual(helper.sync_models(), {})
        self.assertFalse(os.path.exists(self.path("models.json")))

    def test_fails_loudly_on_a_malformed_file(self) -> None:
        self.write("{ nope", "models.json")
        self.save_endpoints(endpoint())
        self.save_cache("local", {"id": "m1"})
        with self.assertRaisesRegex(helper.Fail, r"models\.json: "):
            helper.sync_models()
        with open(self.path("models.json")) as handle:
            self.assertEqual(handle.read(), "{ nope")


class Keys(HelperTestCase):
    def test_saves_a_key_privately_beside_other_credentials_and_releases_the_lock(self) -> None:
        self.write('{"anthropic": {"type": "oauth", "access": "a"}}', "auth.json")
        helper.save_key("gpu", "sk-1")
        self.assertEqual(self.read("auth.json"), {"anthropic": {"type": "oauth", "access": "a"}, "gpu": {"type": "api_key", "key": "sk-1"}})
        self.assertEqual(stat.S_IMODE(os.stat(self.path("auth.json")).st_mode), 0o600)
        self.assertFalse(os.path.exists(self.path("auth.json.lock")))
        helper.save_key("gpu", None)
        self.assertEqual(set(self.read("auth.json")), {"anthropic"})

    def test_waits_for_another_writers_lock_and_reclaims_a_stale_one(self) -> None:
        os.makedirs(self.agent_dir)
        lock = self.path("auth.json.lock")
        os.mkdir(lock)
        with unittest.mock.patch.object(helper, "LOCK_ATTEMPTS", 3), self.assertRaisesRegex(helper.Fail, "Could not lock"):
            helper.save_key("gpu", "sk-1")
        old = time.time() - 60
        os.utime(lock, (old, old))
        helper.save_key("gpu", "sk-1")
        self.assertEqual(helper.stored_key("gpu"), "sk-1")

    def test_prefers_the_saved_key_over_the_environment_variable(self) -> None:
        os.environ["GPU_API_KEY"] = "from-env"
        self.assertEqual(helper.key_for("gpu"), "from-env")
        helper.save_key("gpu", "saved")
        self.assertEqual(helper.key_for("gpu"), "saved")


class Commands(HelperTestCase):
    def test_add_checks_the_endpoint_with_its_key_and_saves_everything(self) -> None:
        server = self.mock(models=["qwen", "llama"], key="sk-new")
        code, out, err = self.run_cli("add", server.base_url + "/", "--name", "My GPU", "--key-stdin", stdin="sk-new\n")

        self.assertEqual((code, err), (0, ""), out)
        self.assertEqual([r["authorization"] for r in server.requests], ["Bearer sk-new"] * 2)
        self.assertEqual(
            self.read("endpoints.json"),
            {"endpoints": [{"id": "my-gpu", "name": "My GPU", "baseUrl": server.base_url, "enabled": True}]},
        )
        self.assertEqual(helper.stored_key("my-gpu"), "sk-new")
        self.assertEqual([m["id"] for m in self.providers()["my-gpu"]["models"]], ["qwen", "llama"])
        self.assertEqual(self.providers()["my-gpu"]["apiKey"], "MY_GPU_API_KEY")
        self.assertIn("2 models", out)
        self.assertIn("/model my-gpu", out)
        self.assertTrue(os.path.exists(self.path("endpoints", "my-gpu.models.json")))

    def test_add_without_a_key_saves_none_and_names_the_endpoint_after_its_host(self) -> None:
        server = self.mock(models=["m"])
        code, _, _ = self.run_cli("add", server.base_url, "--no-key")
        self.assertEqual(code, 0)
        self.assertIsNone(server.requests[0]["authorization"])
        self.assertEqual([e["id"] for e in helper.read_endpoints()], ["127-0-0-1-" + str(server.port)])
        self.assertFalse(os.path.exists(self.path("auth.json")))

    def test_add_without_a_way_to_get_the_key_asks_for_one_instead_of_guessing(self) -> None:
        server = self.mock(models=["m"])
        code, _, err = self.run_cli("add", server.base_url)
        self.assertEqual(code, 1)
        self.assertIn("--key-stdin", err)
        self.assertEqual(server.requests, [])

    def test_add_changes_nothing_when_the_key_is_refused_or_the_url_is_unreachable(self) -> None:
        server = self.mock(models=["m"], key="sk-right")
        code, _, err = self.run_cli("add", server.base_url, "--key-stdin", stdin="sk-wrong\n")
        self.assertEqual(code, 1)
        self.assertRegex(err, r"Not added: .*refused the API key \(HTTP 401\)")
        code, _, err = self.run_cli("add", "http://127.0.0.1:9/v1", "--no-key")
        self.assertEqual(code, 1)
        self.assertRegex(err, r"Not added: could not reach http://127\.0\.0\.1:9/v1/models")
        code, _, err = self.run_cli("add", "ftp://example.com", "--no-key")
        self.assertEqual(code, 1)
        self.assertIn("not an http or https URL", err)
        self.assertEqual(os.listdir(self.directory.name), [], "no agent directory was created")

    def test_add_refuses_ids_that_would_clash(self) -> None:
        server = self.mock(models=["m"])
        self.write(json.dumps({"providers": {"mine": {"baseUrl": "http://x/v1", "apiKey": "k", "api": "openai-completions", "models": [{"id": "a"}]}}}), "models.json")
        self.write('{"signed-in": {"type": "oauth", "access": "a"}}', "auth.json")
        for name, message in (
            ("OpenAI", r'"openai" is a built-in provider'),
            ("Mine", r'"mine" is already a provider in .*models\.json'),
            ("Signed In", r'"signed-in" already has a sign-in'),
        ):
            code, _, err = self.run_cli("add", server.base_url, "--name", name, "--no-key")
            self.assertEqual(code, 1)
            self.assertRegex(err, message)
        self.assertEqual(helper.read_endpoints(), [])

    def test_the_key_never_follows_a_redirect_to_another_host(self) -> None:
        elsewhere = self.mock(models=["m"])
        server = self.mock(models=["m"], redirect_to=f"http://localhost:{elsewhere.port}")
        code, _, err = self.run_cli("add", server.base_url.replace("/v1", "/moved/v1"), "--key-stdin", stdin="sk-secret\n")
        self.assertEqual(code, 1)
        self.assertIn("redirected to another host", err)
        self.assertEqual(elsewhere.requests, [])

    def test_disable_hides_the_models_and_enable_brings_them_back_refreshed(self) -> None:
        server = self.mock(models=["m1", "m2"])
        self.save_endpoints(endpoint(baseUrl=server.base_url))
        self.save_cache("local", {"id": "m1"})
        helper.sync_models()

        code, out, _ = self.run_cli("disable", "local")
        self.assertEqual(code, 0, out)
        self.assertFalse(helper.read_endpoints()[0]["enabled"])
        self.assertEqual(self.providers(), {})

        code, out, _ = self.run_cli("enable", "local")
        self.assertEqual(code, 0, out)
        self.assertIn("2 models", out)
        self.assertEqual([m["id"] for m in self.providers()["local"]["models"]], ["m1", "m2"])

    def test_refresh_updates_the_models_with_the_saved_key_and_reports_each_failure(self) -> None:
        good = self.mock(models=["new-1", "new-2"], key="sk-saved")
        self.save_endpoints(endpoint(baseUrl=good.base_url), endpoint(id="bad", name="Bad", baseUrl="http://127.0.0.1:9/v1"))
        helper.save_key("local", "sk-saved")
        self.save_cache("local", {"id": "old"})
        code, out, err = self.run_cli("refresh")
        self.assertEqual(code, 1)
        self.assertIn("Local: 2 models.", out)
        self.assertRegex(err, r"Bad: could not reach")
        self.assertEqual([m["id"] for m in self.providers()["local"]["models"]], ["new-1", "new-2"])
        self.assertEqual(good.requests[0]["authorization"], "Bearer sk-saved")

    def test_refresh_uses_the_environment_variable_when_no_key_is_saved(self) -> None:
        server = self.mock(models=["m"], key="sk-env")
        self.save_endpoints(endpoint(baseUrl=server.base_url))
        os.environ["LOCAL_API_KEY"] = "sk-env"
        self.assertEqual(self.run_cli("refresh", "local")[0], 0)

    def test_key_saves_and_deletes_and_refreshes_with_the_new_key(self) -> None:
        server = self.mock(models=["m"], key="sk-rotated")
        self.save_endpoints(endpoint(baseUrl=server.base_url))
        code, out, _ = self.run_cli("key", "local", "--key-stdin", stdin="sk-rotated\n")
        self.assertEqual(code, 0, out)
        self.assertEqual(helper.stored_key("local"), "sk-rotated")
        self.assertIn("Refreshed: 1 models", out)
        self.assertEqual(self.run_cli("key", "local", "--remove")[0], 0)
        self.assertIsNone(helper.stored_key("local"))

    def test_url_checks_the_new_address_before_changing_anything(self) -> None:
        server = self.mock(models=["m1"])
        self.save_endpoints(endpoint(baseUrl="http://127.0.0.1:9/v1"))
        code, _, err = self.run_cli("url", "local", "http://127.0.0.1:9/v2")
        self.assertEqual(code, 1)
        self.assertIn("URL not changed", err)
        self.assertEqual(helper.read_endpoints()[0]["baseUrl"], "http://127.0.0.1:9/v1")
        self.assertEqual(self.run_cli("url", "local", server.base_url)[0], 0)
        self.assertEqual(helper.read_endpoints()[0]["baseUrl"], server.base_url)
        self.assertEqual(self.providers()["local"]["baseUrl"], server.base_url)

    def test_remove_deletes_the_endpoint_its_key_its_cache_and_its_provider(self) -> None:
        server = self.mock(models=["m"])
        self.run_cli("add", server.base_url, "--name", "Gone", "--key-stdin", stdin="sk\n")
        self.write('{"gone": {"type": "api_key", "key": "sk"}, "keep": {"type": "api_key", "key": "k"}}', "auth.json")
        code, _, err = self.run_cli("remove", "gone")
        self.assertEqual(code, 1, "needs --yes without a terminal")
        self.assertIn("--yes", err)
        self.assertEqual(self.run_cli("remove", "gone", "--yes")[0], 0)
        self.assertEqual(helper.read_endpoints(), [])
        self.assertEqual(set(self.read("auth.json")), {"keep"})
        self.assertFalse(os.path.exists(self.path("endpoints", "gone.models.json")))
        self.assertEqual(self.providers(), {})

    def test_unknown_ids_are_explained(self) -> None:
        self.save_endpoints(endpoint())
        code, _, err = self.run_cli("enable", "nope")
        self.assertEqual(code, 1)
        self.assertIn('No endpoint "nope". Endpoints: local.', err)

    def test_list_shows_models_key_and_state(self) -> None:
        self.save_endpoints(endpoint(), endpoint(id="off", name="Off", enabled=False), endpoint(id="new", name="New"))
        self.save_cache("local", {"id": "m1"}, {"id": "m2"})
        helper.sync_models()
        helper.save_key("local", "sk")
        code, out, _ = self.run_cli("list")
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], "Local [local] - 127.0.0.1:9 - 2 models - key saved")
        self.assertEqual(lines[1], "Off [off] - 127.0.0.1:9 - disabled - no key")
        self.assertIn("no model list yet", lines[2])

    def test_unsloth_status_makes_the_loaded_model_a_toggle_with_its_context(self) -> None:
        status = {
            "supports_reasoning": True,
            "reasoning_style": "enable_thinking_effort",
            "reasoning_effort_levels": ["low", "medium", "xhigh"],
            "reasoning_always_on": False,
            "context_length": 188672,
            "loaded": ["zz-thinker"],
        }
        server = self.mock(models=["zz-thinker", "other"], status=status)
        self.assertEqual(self.run_cli("add", server.base_url, "--name", "Unsloth", "--no-key")[0], 0)
        models = {m["id"]: m for m in self.providers()["unsloth"]["models"]}
        self.assertEqual(models["zz-thinker"]["contextWindow"], 188672)
        self.assertEqual(self.providers()["unsloth"]["compat"]["thinkingFormat"], "qwen")
        self.assertFalse(models["other"]["reasoning"])

    def test_sync_rebuilds_models_json_from_the_saved_state_without_the_network(self) -> None:
        self.save_endpoints(endpoint(contextWindow=32000))
        self.save_cache("local", {"id": "m1"})
        code, out, _ = self.run_cli("sync")
        self.assertEqual((code, out), (0, "local: 1 models.\n"))
        self.assertEqual(self.providers()["local"]["models"][0]["contextWindow"], 32000)


class Update(HelperTestCase):
    def publish(self, script: bytes, checksum: Optional[str] = None) -> str:
        digest = checksum or hashlib.sha256(script).hexdigest()
        server = self.mock(
            files={
                "/helper/prime-agent-endpoints": script,
                "/helper/SHA256SUMS": f"{digest}  prime-agent-endpoints\n".encode(),
            }
        )
        os.environ["PRIME_AGENT_ENDPOINTS_BASE_URL"] = f"http://127.0.0.1:{server.port}"
        self.addCleanup(os.environ.pop, "PRIME_AGENT_ENDPOINTS_BASE_URL", None)
        return self.installed("old version\n")

    def installed(self, content: str) -> str:
        path = os.path.join(self.directory.name, "prime-agent-endpoints")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(path, 0o755)
        patch = unittest.mock.patch.object(helper, "__file__", path)
        patch.start()
        self.addCleanup(patch.stop)
        return path

    def test_replaces_the_helper_with_the_published_one_and_keeps_it_executable(self) -> None:
        path = self.publish(b"new version\n")
        code, out, err = self.run_cli("update")
        self.assertEqual((code, err), (0, ""))
        self.assertIn("Updated", out)
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "new version\n")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o755)
        self.assertEqual(self.run_cli("update")[1], "Already up to date.\n")

    def test_check_reports_without_changing_anything(self) -> None:
        path = self.publish(b"new version\n")
        code, out, _ = self.run_cli("update", "--check")
        self.assertEqual(code, 0)
        self.assertIn("update is available", out)
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "old version\n")

    def test_refuses_a_download_that_does_not_match_its_checksum(self) -> None:
        path = self.publish(b"tampered\n", checksum="0" * 64)
        code, _, err = self.run_cli("update")
        self.assertEqual(code, 1)
        self.assertIn("does not match its published checksum", err)
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "old version\n")

    def test_names_the_site_when_it_cannot_be_reached(self) -> None:
        self.installed("old version\n")
        os.environ["PRIME_AGENT_ENDPOINTS_BASE_URL"] = "http://127.0.0.1:9"
        self.addCleanup(os.environ.pop, "PRIME_AGENT_ENDPOINTS_BASE_URL", None)
        code, _, err = self.run_cli("update")
        self.assertEqual(code, 1)
        self.assertIn("could not download the helper from http://127.0.0.1:9", err)


if __name__ == "__main__":
    unittest.main()
