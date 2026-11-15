//! A gateway refresh belongs to one reviewed and successfully activated web update.
#[derive(Default)]
pub struct Review {
    web_revision: Option<String>,
    operation: Option<String>,
}
impl Review {
    pub fn plan(&mut self, plan: &serde_json::Value) {
        self.web_revision = if plan["ready"] == true && plan["candidates"].get("web").is_some() {
            plan["revision"].as_str().map(str::to_owned)
        } else {
            None
        };
    }
    pub fn approved(&self, input: &serde_json::Value) -> bool {
        input["confirmed"] == true
            && input["restartConsent"] == true
            && self
                .web_revision
                .as_deref()
                .is_some_and(|r| input["revision"] == r)
    }
    pub fn started(&mut self, approved: bool, result: &serde_json::Value) {
        if approved && result["started"] == true {
            self.operation = result["operation"].as_str().map(str::to_owned);
        }
        self.web_revision = None;
    }
    pub fn completed(&mut self, status: &serde_json::Value) -> bool {
        if self
            .operation
            .as_deref()
            .is_none_or(|op| status["operation"] != op)
        {
            return false;
        }
        match status["phase"].as_str() {
            Some("completed") => {
                self.operation = None;
                true
            }
            Some("failed") => {
                self.operation = None;
                false
            }
            _ => false,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_reviewed_successful_web_operation_refreshes_once() {
        let mut review = Review::default();
        let install = json!({"confirmed":true,"restartConsent":true,"revision":"current"});
        assert!(!review.approved(&install));
        review.plan(
            &json!({"ready":true,"revision":"current","candidates":{"web":{"version":"0.2.0"}}}),
        );
        assert!(!review.approved(&json!({"confirmed":true,"revision":"current"})));
        assert!(
            !review.approved(&json!({"confirmed":true,"restartConsent":true,"revision":"stale"}))
        );
        review.started(
            review.approved(&install),
            &json!({"started":true,"operation":"owned"}),
        );
        assert!(!review.completed(&json!({"operation":"owned","phase":"installing"})));
        assert!(!review.completed(&json!({"operation":"other","phase":"completed"})));
        assert!(review.completed(&json!({"operation":"owned","phase":"completed"})));
        assert!(!review.completed(&json!({"operation":"owned","phase":"completed"})));
    }
    #[test]
    fn downloads_non_web_changes_and_failed_activation_never_refresh() {
        let mut review = Review::default();
        review.plan(&json!({"ready":true,"revision":"current","candidates":{"server":{}}}));
        assert!(
            !review.approved(&json!({"confirmed":true,"restartConsent":true,"revision":"current"}))
        );
        review.plan(&json!({"ready":true,"revision":"current","candidates":{"web":{}}}));
        review.started(true, &json!({"started":true,"operation":"owned"}));
        assert!(!review.completed(&json!({"operation":"owned","phase":"failed"})));
        assert!(!review.completed(&json!({"operation":"owned","phase":"completed"})));
    }
}
