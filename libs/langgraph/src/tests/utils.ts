/* eslint-disable no-promise-executor-return */
import assert from "node:assert";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { BaseMessage, AIMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { RunnableConfig } from "@langchain/core/runnables";
import { Tool } from "@langchain/core/tools";
import {
  MemorySaver,
  Checkpoint,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import { z } from "zod";

export interface FakeChatModelArgs extends BaseChatModelParams {
  responses: BaseMessage[];
}

export class FakeChatModel extends BaseChatModel {
  responses: BaseMessage[];

  callCount = 0;

  constructor(fields: FakeChatModelArgs) {
    super(fields);
    this.responses = fields.responses;
  }

  _combineLLMOutput() {
    return [];
  }

  _llmType(): string {
    return "fake";
  }

  async _generate(
    messages: BaseMessage[],
    options?: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    if (options?.stop?.length) {
      return {
        generations: [
          {
            message: new AIMessage(options.stop[0]),
            text: options.stop[0],
          },
        ],
      };
    }
    const response = this.responses[this.callCount % this.responses.length];
    const text = messages.map((m) => m.content).join("\n");
    this.callCount += 1;
    await runManager?.handleLLMNewToken(text);
    return {
      generations: [
        {
          message: response ?? new AIMessage(text),
          text: response ? (response.content as string) : text,
        },
      ],
      llmOutput: {},
    };
  }
}

export class FakeToolCallingChatModel extends BaseChatModel {
  sleep?: number = 50;

  responses?: BaseMessage[];

  thrownErrorString?: string;

  idx: number;

  constructor(
    fields: {
      sleep?: number;
      responses?: BaseMessage[];
      thrownErrorString?: string;
    } & BaseChatModelParams
  ) {
    super(fields);
    this.sleep = fields.sleep ?? this.sleep;
    this.responses = fields.responses;
    this.thrownErrorString = fields.thrownErrorString;
    this.idx = 0;
  }

  _llmType() {
    return "fake";
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    if (this.thrownErrorString) {
      throw new Error(this.thrownErrorString);
    }
    if (this.sleep !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.sleep));
    }
    const msg = this.responses?.[this.idx] ?? messages[this.idx];
    const generation: ChatResult = {
      generations: [
        {
          text: "",
          message: msg,
        },
      ],
    };
    this.idx += 1;

    return generation;
  }

  bindTools(_: Tool[]) {
    return new FakeToolCallingChatModel({
      sleep: this.sleep,
      responses: this.responses,
      thrownErrorString: this.thrownErrorString,
    });
  }
}

export class MemorySaverAssertImmutable extends MemorySaver {
  storageForCopies: Record<string, Record<string, string>> = {};

  constructor() {
    super();
    this.storageForCopies = {};
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const thread_id = config.configurable?.thread_id;
    if (!this.storageForCopies[thread_id]) {
      this.storageForCopies[thread_id] = {};
    }
    // assert checkpoint hasn't been modified since last written
    const saved = await super.get(config);
    if (saved) {
      const savedId = saved.id;
      if (this.storageForCopies[thread_id][savedId]) {
        assert(
          JSON.stringify(saved) === this.storageForCopies[thread_id][savedId],
          "Checkpoint has been modified since last written"
        );
      }
    }
    const [, serializedCheckpoint] = this.serde.dumpsTyped(checkpoint);
    // save a copy of the checkpoint
    this.storageForCopies[thread_id][checkpoint.id] = new TextDecoder().decode(
      serializedCheckpoint
    );

    return super.put(config, checkpoint, metadata);
  }
}

export class FakeSearchTool extends Tool {
  name = "search_api";

  description = "A simple API that returns the input string.";

  schema = z
    .object({
      input: z.string().optional(),
    })
    .transform((data) => data.input);

  constructor() {
    super();
  }

  async _call(query: string): Promise<string> {
    return `result for ${query}`;
  }
}

class AnyStringSame {
  $$typeof = Symbol.for("jest.asymmetricMatcher");

  private lastValue: string | undefined = undefined;

  private key: string;

  constructor(key: string) {
    this.key = key;
  }

  asymmetricMatch(other: unknown) {
    // eslint-disable-next-line no-instanceof/no-instanceof
    if (!(typeof other === "string" || other instanceof String)) {
      return false;
    }

    if (this.lastValue != null && this.lastValue !== other) {
      return false;
    }

    this.lastValue = other as string;
    return true;
  }

  toString() {
    return "AnyStringSame";
  }

  getExpectedType() {
    return "string";
  }

  toAsymmetricMatcher() {
    if (this.lastValue != null)
      return `AnyStringSame<${this.key}, ${this.lastValue}>`;
    return `AnyStringSame<${this.key}>`;
  }
}

export const createAnyStringSame = () => {
  const memory = new Map<string, AnyStringSame>();

  return (key: string) => {
    if (!memory.has(key)) memory.set(key, new AnyStringSame(key));
    return memory.get(key);
  };
};