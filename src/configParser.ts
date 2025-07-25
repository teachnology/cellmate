import * as vscode from 'vscode';

export type ProviderType = 'local' | 'openai' | 'azure';

export interface ProviderConfig {
  provider: ProviderType;
  language?: string;        // Common language code

  // OpenAI
  openaiApiKey?: string;
  openaiModel?: string;

  // Azure
  azureApiKey?: string;
  azureRegion?: string;
}

export function getProviderConfig(): ProviderConfig {
  const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
  const provider = cfg.get<ProviderType>('speechProvider') || 'local';

  /** ---------- Local (offline) ---------- */
  if (provider === 'local') {
    const language = cfg.get<string>('speechLocal.language');
    return {
      provider,
      // If the user does not set the language, pass undefined to let Whisper auto-detect
      language: language || undefined
    };
  }

  /** ---------- OpenAI Whisper ---------- */
  if (provider === 'openai') {
    const openaiApiKey = cfg.get<string>('speechOpenai.apiKey');
    if (!openaiApiKey) {
      throw new Error('❌ Missing OpenAI API Key. Please set jupyterAiFeedback.speechOpenai.apiKey.');
    }
    const language = cfg.get<string>('speechOpenai.language');
    return {
      provider,
      // If the user does not set the language, pass undefined to let OpenAI auto-detect
      language: language || undefined,
      openaiApiKey,
      openaiModel: cfg.get('speechOpenai.modelId') || 'whisper-1'
    };
  }

  /** ---------- Azure Speech ---------- */
  if (provider === 'azure') {
    const azureApiKey = cfg.get<string>('speechAzure.apiKey');
    const azureRegion = cfg.get<string>('speechAzure.region');
    if (!azureApiKey || !azureRegion) {
      throw new Error(
        '❌ Missing Azure API Key or Region. Please set jupyterAiFeedback.speechAzure.apiKey and .speechAzure.region.'
      );
    }
    return {
      provider,
      language: cfg.get<string>('speechAzure.language') || 'en-US',
      azureApiKey,
      azureRegion
    };
  }

  // Should theoretically never reach here
  throw new Error('Unsupported speechProvider');
}
