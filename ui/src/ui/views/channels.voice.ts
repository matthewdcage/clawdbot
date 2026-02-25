import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { VoiceStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderVoiceCard(params: {
  props: ChannelsProps;
  voice?: VoiceStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, voice, accountCountLabel } = params;

  const providerLabel = voice?.provider
    ? voice.provider.charAt(0).toUpperCase() + voice.provider.slice(1)
    : "n/a";

  return html`
    <div class="card">
      <div class="card-title">Voice Call</div>
      <div class="card-sub">Telephony voice channel (3CX, Twilio, Telnyx).</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${voice?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${voice?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Provider</span>
          <span>${providerLabel}</span>
        </div>
        ${
          voice?.provider === "threecx"
            ? html`<div>
                <span class="label">SIP connected</span>
                <span>${voice.connected ? "Yes" : "No"}</span>
              </div>`
            : nothing
        }
        <div>
          <span class="label">Active calls</span>
          <span>${voice?.activeCalls ?? 0}</span>
        </div>
        ${
          voice?.fromNumber
            ? html`<div>
                <span class="label">From number</span>
                <span>${voice.fromNumber}</span>
              </div>`
            : nothing
        }
        <div>
          <span class="label">Last start</span>
          <span>${voice?.lastStartAt ? formatRelativeTimestamp(voice.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last inbound</span>
          <span>${voice?.lastInboundAt ? formatRelativeTimestamp(voice.lastInboundAt) : "n/a"}</span>
        </div>
      </div>

      ${
        voice?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${voice.lastError}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "voice", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          Refresh
        </button>
      </div>
    </div>
  `;
}
