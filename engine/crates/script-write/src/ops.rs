//! The engine operations of the script writers.
//!
//! New in the parallel port; adapted from no TypeScript file. Each writer is one operation named
//! `<writer>.plan`. The request body carries the tool input and the path of the source; the
//! payload is the source bytes (empty for a new file). The answer is the plan's JSON and, as its
//! payload, the bytes of the file after the edit.

use hoi4_core::ops::{OpContext, OpResponse, Registry};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::character::{self, CharacterWriteInput};
use crate::common::{self, CommonWriteInput};
use crate::decision::{self, DecisionWriteInput};
use crate::doctrine::{self, DoctrineWriteInput};
use crate::event::{self, EventWriteInput};
use crate::idea::{self, IdeaWriteInput};
use crate::source::WriteResult;
use crate::tech::{self, TechWriteInput};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanRequest<I> {
    input: I,
    path: String,
    #[serde(default)]
    new_file: bool,
}

fn respond(result: WriteResult<(Value, Vec<u8>)>) -> OpResponse {
    match result {
        Ok((plan, bytes)) => OpResponse::ok_with_payload(plan, bytes),
        Err(error) => OpResponse { result: Err(error.to_json()), payload: Vec::new() },
    }
}

fn parse<I: DeserializeOwned>(request: &Value) -> Result<PlanRequest<I>, OpResponse> {
    serde_json::from_value(request.clone()).map_err(|error| OpResponse::error("invalid_request", format!("The write request is malformed: {error}")))
}

fn idea_plan(_: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
    let request = match parse::<IdeaWriteInput>(request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let plan =
        if request.new_file { idea::plan_new_idea_file(&request.path, &request.input) } else { idea::plan_idea_write(payload, &request.path, &request.input) };
    respond(plan.map(|plan| (plan.to_json(), plan.bytes)))
}

fn idea_categories(_: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
    let Some(path) = request.get("path").and_then(Value::as_str) else {
        return OpResponse::error("invalid_request", "The categories request needs a path");
    };
    OpResponse::ok(json!({ "categories": idea::idea_categories(payload, path) }))
}

fn character_plan(_: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
    let request = match parse::<CharacterWriteInput>(request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let plan = if request.new_file {
        character::plan_new_character_file(&request.path, &request.input)
    } else {
        character::plan_character_write(payload, &request.path, &request.input)
    };
    respond(plan.map(|plan| (plan.to_json(), plan.bytes)))
}

fn decision_plan(_: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
    let request = match parse::<DecisionWriteInput>(request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let plan = if request.new_file {
        decision::plan_new_decision_file(&request.path, &request.input)
    } else {
        decision::plan_decision_write(payload, &request.path, &request.input)
    };
    respond(plan.map(|plan| (plan.to_json(), plan.bytes)))
}

fn decision_categories(_: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
    let Some(path) = request.get("path").and_then(Value::as_str) else {
        return OpResponse::error("invalid_request", "The categories request needs a path");
    };
    OpResponse::ok(json!({ "categories": decision::decision_categories(payload, path) }))
}

fn tech_plan(_: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
    let request = match parse::<TechWriteInput>(request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let plan = if request.new_file {
        tech::plan_new_technology_file(&request.path, &request.input)
    } else {
        tech::plan_technology_write(payload, &request.path, &request.input)
    };
    respond(plan.map(|plan| (plan.to_json(), plan.bytes)))
}

fn doctrine_plan(_: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
    let request = match parse::<DoctrineWriteInput>(request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let plan = if request.new_file {
        doctrine::plan_new_doctrine_file(&request.path, &request.input)
    } else {
        doctrine::plan_doctrine_write(payload, &request.path, &request.input)
    };
    respond(plan.map(|plan| (plan.to_json(), plan.bytes)))
}

fn event_plan(_: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
    let request = match parse::<EventWriteInput>(request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let plan = if request.new_file {
        event::plan_new_event_file(&request.path, &request.input)
    } else {
        event::plan_event_write(payload, &request.path, &request.input)
    };
    respond(plan.map(|plan| (plan.to_json(), plan.bytes)))
}

fn event_contents(_: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
    let Some(path) = request.get("path").and_then(Value::as_str) else {
        return OpResponse::error("invalid_request", "The contents request needs a path");
    };
    let (ids, namespaces) = event::event_file_contents(payload, path);
    OpResponse::ok(json!({ "ids": ids, "namespaces": namespaces }))
}

fn common_plan(_: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
    let request = match parse::<CommonWriteInput>(request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    respond(common::plan_common_write(payload, &request.path, &request.input, request.new_file).map(|plan| (plan.to_json(), plan.bytes)))
}

pub fn register(registry: &mut Registry) {
    registry.add_fn("common.block_write.plan", common_plan);
    registry.add_fn("event_write.plan", event_plan);
    registry.add_fn("event_write.contents", event_contents);
    registry.add_fn("tech_write.plan", tech_plan);
    registry.add_fn("doctrine_write.plan", doctrine_plan);
    registry.add_fn("decision_write.plan", decision_plan);
    registry.add_fn("decision_write.categories", decision_categories);
    registry.add_fn("character_write.plan", character_plan);
    registry.add_fn("idea_write.plan", idea_plan);
    registry.add_fn("idea_write.categories", idea_categories);
}
