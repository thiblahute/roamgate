/**
 * Recorded (slimmed) from a real conversation-mode transcript: the user sent
 * "I think you should check out his last messages." and "No, I'm telling you
 * to look at Romate last messages.", each through Claude Code's queue, then
 * rewound to before the first from the chat. The next message hangs from
 * before them. Texts are cut short; thinking blocks emptied.
 */
export const rewoundAfterQueuedRecords: Record<string, unknown>[] = [
  {
    type: "system",
    uuid: "f181ec1f-6dff-481f-9806-a65f39f63350",
    parentUuid: "5a51f374-39ee-4260-a38c-ff872838f98d",
    timestamp: "2026-11-05T00:27:07.413Z",
    subtype: "stop_hook_summary",
  },
  {
    type: "queue-operation",
    operation: "dequeue",
    timestamp: "2026-11-05T00:27:07.417Z",
  },
  {
    type: "user",
    uuid: "71020648-3842-427a-b0a6-5fb0d805a392",
    parentUuid: "f181ec1f-6dff-481f-9806-a65f39f63350",
    timestamp: "2026-11-05T00:27:07.421Z",
    message: {
      role: "user",
      content:
        '<task-notification>\n<task-id>x</task-id>\n<summary>Agent "Vet Spotify MCP servers" finished</summary>\n</task-notification>',
    },
  },
  {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-11-05T00:27:47.742Z",
    content: "I think you should check out his last messages.",
  },
  {
    type: "queue-operation",
    operation: "dequeue",
    timestamp: "2026-11-05T00:27:47.783Z",
  },
  {
    type: "user",
    uuid: "f7f8aeb9-4b65-4a2f-a609-078e307ccf59",
    parentUuid: "71020648-3842-427a-b0a6-5fb0d805a392",
    timestamp: "2026-11-05T00:27:47.794Z",
    message: {
      role: "user",
      content: "I think you should check out his last messages.",
    },
  },
  {
    type: "assistant",
    uuid: "2098fe1d-44a4-4640-bcd0-9ebae6011dda",
    parentUuid: "f7f8aeb9-4b65-4a2f-a609-078e307ccf59",
    timestamp: "2026-11-05T00:27:51.820Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
        },
      ],
      id: "msg_011CgiqK9JeneMPX7tsrwLxQ",
      stop_reason: "end_turn",
    },
  },
  {
    type: "assistant",
    uuid: "56f83c83-d1ad-4e9f-a5a5-a504e91b0772",
    parentUuid: "2098fe1d-44a4-4640-bcd0-9ebae6011dda",
    timestamp: "2026-11-05T00:27:52.790Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I'm not sure whose messages you mean. Is it:\n- **the Olmo session's,** about the",
        },
      ],
      id: "msg_011CgiqK9JeneMPX7tsrwLxQ",
      stop_reason: "end_turn",
    },
  },
  {
    type: "system",
    uuid: "df992351-b089-4db7-b04c-eab2ce51288e",
    parentUuid: "56f83c83-d1ad-4e9f-a5a5-a504e91b0772",
    timestamp: "2026-11-05T00:27:52.914Z",
    subtype: "stop_hook_summary",
  },
  {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-11-05T00:28:03.652Z",
    content: "No, I'm telling you to look at Romate last messages.",
  },
  {
    type: "queue-operation",
    operation: "dequeue",
    timestamp: "2026-11-05T00:28:03.739Z",
  },
  {
    type: "user",
    uuid: "2ee463be-37a3-45e8-8e7d-362385467cc5",
    parentUuid: "df992351-b089-4db7-b04c-eab2ce51288e",
    timestamp: "2026-11-05T00:28:03.746Z",
    message: {
      role: "user",
      content: "No, I'm telling you to look at Romate last messages.",
    },
  },
  {
    type: "assistant",
    uuid: "1f3c7afa-20fa-4014-93d5-7cb2551e09d1",
    parentUuid: "2ee463be-37a3-45e8-8e7d-362385467cc5",
    timestamp: "2026-11-05T00:28:07.072Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
        },
      ],
      id: "msg_011CgiqLKQtmbTE23U586Coo",
      stop_reason: "tool_use",
    },
  },
  {
    type: "assistant",
    uuid: "42b81480-b86e-411f-9dde-5617ea15919d",
    parentUuid: "1f3c7afa-20fa-4014-93d5-7cb2551e09d1",
    timestamp: "2026-11-05T00:28:08.659Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_019PX5Vb3X6qAX9p2SJWNSFM",
          name: "Bash",
          input: {},
        },
      ],
      id: "msg_011CgiqLKQtmbTE23U586Coo",
      stop_reason: "tool_use",
    },
  },
  {
    type: "user",
    uuid: "622d7b94-c878-4368-a6f5-1c54dfdc9425",
    parentUuid: "42b81480-b86e-411f-9dde-5617ea15919d",
    timestamp: "2026-11-05T00:28:10.711Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_019PX5Vb3X6qAX9p2SJWNSFM",
          content: "ok",
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "7c0ed0cb-33b4-401d-b4ba-d387e64cc4ae",
    parentUuid: "622d7b94-c878-4368-a6f5-1c54dfdc9425",
    timestamp: "2026-11-05T00:28:13.286Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_015cVu6h3UxignRAKUJy5vYU",
          name: "Bash",
          input: {},
        },
      ],
      id: "msg_011CgiqLqE2MrkWnVNi5uDc7",
      stop_reason: "tool_use",
    },
  },
  {
    type: "user",
    uuid: "ef38f251-7d80-4137-92ff-a863def21612",
    parentUuid: "7c0ed0cb-33b4-401d-b4ba-d387e64cc4ae",
    timestamp: "2026-11-05T00:28:14.395Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_015cVu6h3UxignRAKUJy5vYU",
          content: "ok",
        },
      ],
    },
  },
  {
    type: "last-prompt",
    leafUuid: "ef38f251-7d80-4137-92ff-a863def21612",
    lastPrompt: "No, I'm telling you to look at Romate last messages.",
  },
  {
    type: "assistant",
    uuid: "10f98283-b4f7-45a5-9290-31fe3dc46b7f",
    parentUuid: "ef38f251-7d80-4137-92ff-a863def21612",
    timestamp: "2026-11-05T00:28:17.090Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01AAfrXZRFVkDjhcQpNbSCwb",
          name: "Bash",
          input: {},
        },
      ],
      id: "msg_011CgiqM6trSSr3TQyjtwXca",
      stop_reason: "tool_use",
    },
  },
  {
    type: "user",
    uuid: "16980dcd-428c-4cdf-8a70-82ca358190ad",
    parentUuid: "10f98283-b4f7-45a5-9290-31fe3dc46b7f",
    timestamp: "2026-11-05T00:28:22.996Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01AAfrXZRFVkDjhcQpNbSCwb",
          content: "ok",
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "77f47d48-97b7-44ee-97cd-05e84c017fe2",
    parentUuid: "16980dcd-428c-4cdf-8a70-82ca358190ad",
    timestamp: "2026-11-05T00:28:26.740Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
        },
      ],
      id: "msg_011CgiqMjdhZodqBgMajEG8Z",
      stop_reason: "tool_use",
    },
  },
  {
    type: "assistant",
    uuid: "73657cc8-18ca-425c-82e4-a087e1284c6a",
    parentUuid: "77f47d48-97b7-44ee-97cd-05e84c017fe2",
    timestamp: "2026-11-05T00:28:27.771Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01CUjbqM4kZR42XXZGVy6dfi",
          name: "Bash",
          input: {},
        },
      ],
      id: "msg_011CgiqMjdhZodqBgMajEG8Z",
      stop_reason: "tool_use",
    },
  },
  {
    type: "user",
    uuid: "19f54d0f-1587-44dd-962d-8fe2dd3dcbce",
    parentUuid: "73657cc8-18ca-425c-82e4-a087e1284c6a",
    timestamp: "2026-11-05T00:28:29.143Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01CUjbqM4kZR42XXZGVy6dfi",
          content: "ok",
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "12a7b419-0036-4ebf-9a57-c1b459124c1c",
    parentUuid: "19f54d0f-1587-44dd-962d-8fe2dd3dcbce",
    timestamp: "2026-11-05T00:28:31.548Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01JVtn2wzDKaJ1DMQFtHY2cW",
          name: "Bash",
          input: {},
        },
      ],
      id: "msg_011CgiqNBwyxvoRKPCyinDTz",
      stop_reason: "tool_use",
    },
  },
  {
    type: "user",
    uuid: "a11cf224-32ac-416e-83aa-479116dc0aa1",
    parentUuid: "12a7b419-0036-4ebf-9a57-c1b459124c1c",
    timestamp: "2026-11-05T00:28:32.527Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01JVtn2wzDKaJ1DMQFtHY2cW",
          content: "ok",
        },
      ],
    },
  },
  {
    type: "attachment",
    uuid: "852bccec-daf5-416e-83de-5a1945a4afa2",
    parentUuid: "a11cf224-32ac-416e-83aa-479116dc0aa1",
    timestamp: "2026-11-05T00:28:32.533Z",
    attachment: {
      type: "silent_turn_reminder",
    },
  },
  {
    type: "assistant",
    uuid: "aca10ab2-cbbd-41d0-932c-0ec0daf4c47d",
    parentUuid: "852bccec-daf5-416e-83de-5a1945a4afa2",
    timestamp: "2026-11-05T00:28:42.224Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
        },
      ],
      id: "msg_011CgiqNSV6Zk47NTxY5PKvw",
      stop_reason: "tool_use",
    },
  },
  {
    type: "assistant",
    uuid: "537ce979-b99f-41df-bd38-bf185ac259a5",
    parentUuid: "aca10ab2-cbbd-41d0-932c-0ec0daf4c47d",
    timestamp: "2026-11-05T00:28:42.226Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
        },
      ],
      id: "msg_011CgiqNSV6Zk47NTxY5PKvw",
      stop_reason: "tool_use",
    },
  },
  {
    type: "assistant",
    uuid: "a909b3b3-74b6-4506-910c-ddcebf08782a",
    parentUuid: "537ce979-b99f-41df-bd38-bf185ac259a5",
    timestamp: "2026-11-05T00:28:50.681Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_017oruukcr14MvuyZqKJDPfY",
          name: "Agent",
          input: {},
        },
      ],
      id: "msg_011CgiqNSV6Zk47NTxY5PKvw",
      stop_reason: "tool_use",
    },
  },
  {
    type: "user",
    uuid: "165512dd-1d06-48e0-991e-a0fc67958718",
    parentUuid: "a909b3b3-74b6-4506-910c-ddcebf08782a",
    timestamp: "2026-11-05T00:28:50.797Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_017oruukcr14MvuyZqKJDPfY",
          content: "ok",
        },
      ],
    },
  },
  {
    type: "last-prompt",
    leafUuid: "165512dd-1d06-48e0-991e-a0fc67958718",
    lastPrompt: "No, I'm telling you to look at Romate last messages.",
  },
  {
    type: "assistant",
    uuid: "a9a0db6b-f596-4614-88e4-6926f5103156",
    parentUuid: "165512dd-1d06-48e0-991e-a0fc67958718",
    timestamp: "2026-11-05T00:28:53.950Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
        },
      ],
      id: "msg_011CgiqPncbYX1aA4pnMGbvK",
      stop_reason: "end_turn",
    },
  },
  {
    type: "assistant",
    uuid: "dc0ae100-ab8d-4021-938b-831ebc3ec2b9",
    parentUuid: "a9a0db6b-f596-4614-88e4-6926f5103156",
    timestamp: "2026-11-05T00:28:53.953Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I've started an agent on the fix:\n- everything you say aloud and the companion p",
        },
      ],
      id: "msg_011CgiqPncbYX1aA4pnMGbvK",
      stop_reason: "end_turn",
    },
  },
  {
    type: "system",
    uuid: "79aced63-6e57-4c68-a1f1-3d2286441a12",
    parentUuid: "dc0ae100-ab8d-4021-938b-831ebc3ec2b9",
    timestamp: "2026-11-05T00:28:54.083Z",
    subtype: "stop_hook_summary",
  },
  {
    type: "last-prompt",
    rewound: true,
    cutUuid: "f7f8aeb9-4b65-4a2f-a609-078e307ccf59",
    leafUuid: "71020648-3842-427a-b0a6-5fb0d805a392",
    lastPrompt: "No, I'm telling you to look at Romate last messages.",
  },
  {
    type: "queue-operation",
    operation: "remove",
    timestamp: "2026-11-05T00:29:18.601Z",
    content:
      '<task-notification>\n<task-id>x</task-id>\n<summary>Agent "Vet Spotify MCP servers" finished</summary>\n</task-notification>',
  },
  {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-11-05T00:30:00.491Z",
    content:
      "whether the um mcp the sound can be used as a generic connector inside cloud",
  },
  {
    type: "queue-operation",
    operation: "dequeue",
    timestamp: "2026-11-05T00:30:00.507Z",
  },
  {
    type: "user",
    uuid: "c49547b3-9557-4754-9b93-8c246d92f751",
    parentUuid: "71020648-3842-427a-b0a6-5fb0d805a392",
    timestamp: "2026-11-05T00:30:00.521Z",
    message: {
      role: "user",
      content:
        "whether the um mcp the sound can be used as a generic connector inside cloud",
    },
  },
  {
    type: "assistant",
    uuid: "5e59da12-2142-4778-ba2f-d22c5ba23998",
    parentUuid: "c49547b3-9557-4754-9b93-8c246d92f751",
    timestamp: "2026-11-05T00:30:08.735Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
        },
      ],
      id: "msg_011CgiqV3e7yf5Kes7R7aF6X",
      stop_reason: "end_turn",
    },
  },
  {
    type: "assistant",
    uuid: "a107bb87-7966-453f-9ec1-bbc6ca134a13",
    parentUuid: "5e59da12-2142-4778-ba2f-d22c5ba23998",
    timestamp: "2026-11-05T00:30:13.249Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Yes, there are two levels:\n\n1. **In Claude Code, on your machines:** you can add",
        },
      ],
      id: "msg_011CgiqV3e7yf5Kes7R7aF6X",
      stop_reason: "end_turn",
    },
  },
  {
    type: "last-prompt",
    leafUuid: "a107bb87-7966-453f-9ec1-bbc6ca134a13",
    lastPrompt: "whether the um mcp the sound can be used as a generic connec",
  },
];
