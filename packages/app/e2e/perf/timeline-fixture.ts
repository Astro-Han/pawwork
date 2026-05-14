type TimelineProject = {
  sdk: {
    session: {
      promptAsync(input: { sessionID: string; noReply: true; parts: Array<{ type: "text"; text: string }> }): Promise<unknown>
    }
  }
}

export async function seedTimelineRecomputeSession(project: TimelineProject, sessionID: string) {
  for (let turn = 0; turn < 36; turn += 1) {
    await project.sdk.session.promptAsync({
      sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: [
            `timeline recompute seed turn ${turn}`,
            `owner user-${turn % 4}`,
            `plain text payload ${"content ".repeat(18)}`,
            `status line ${turn % 3}`,
          ].join("\n"),
        },
      ],
    })
  }
}
