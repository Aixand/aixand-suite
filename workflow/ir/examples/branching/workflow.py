import aixand

@aixand.workflow
async def review_document(task: str):
    result = await aixand.verifier.verify(
        {"title": "Review", "body": task, "labels": []},
        required_terms=["workflow"],
    )

    if result.passed:
        await aixand.verifier.verify(
            {"title": "Accepted", "body": "The workflow passed review.", "labels": []}
        )
    else:
        await aixand.verifier.verify(
            {"title": "Needs revision", "body": "Please describe the workflow.", "labels": []}
        )

    await aixand.verifier.verify(
        {"title": "Review complete", "body": task, "labels": []}
    )
    return {"passed": result.passed, "summary": result.summary}
