package com.romp.ccremote.ui;

import android.text.method.LinkMovementMethod;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.romp.ccremote.R;
import com.romp.ccremote.model.ChatMessage;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

import io.noties.markwon.Markwon;
import io.noties.markwon.core.CorePlugin;
import io.noties.markwon.ext.tables.TablePlugin;

/**
 * RecyclerView adapter for chat-style terminal display.
 * Uses Markwon to render Markdown in Claude responses (including tables).
 * User messages are shown as plain text (right-aligned, blue).
 */
public class ChatAdapter extends RecyclerView.Adapter<ChatAdapter.Holder> {

    private static final int VIEW_TYPE_USER = 0;
    private static final int VIEW_TYPE_CLAUDE = 1;

    private final List<ChatMessage> messages = new ArrayList<>();
    private final SimpleDateFormat timeFmt = new SimpleDateFormat("HH:mm", Locale.getDefault());
    private Markwon markwon;
    private boolean markwonInited;

    public void addMessage(ChatMessage msg) {
        messages.add(msg);
        notifyItemInserted(messages.size() - 1);
    }

    public void removeLast() {
        if (messages.isEmpty()) return;
        int pos = messages.size() - 1;
        messages.remove(pos);
        notifyItemRemoved(pos);
    }

    public void replaceLast(ChatMessage msg) {
        if (messages.isEmpty()) {
            addMessage(msg);
            return;
        }
        int pos = messages.size() - 1;
        messages.set(pos, msg);
        notifyItemChanged(pos);
    }

    public void clear() {
        int size = messages.size();
        if (size == 0) return;
        messages.clear();
        notifyItemRangeRemoved(0, size);
    }

    @Override
    public int getItemViewType(int position) {
        return messages.get(position).isUser() ? VIEW_TYPE_USER : VIEW_TYPE_CLAUDE;
    }

    @NonNull
    @Override
    public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        LayoutInflater inflater = LayoutInflater.from(parent.getContext());
        if (viewType == VIEW_TYPE_USER) {
            return new Holder(inflater.inflate(R.layout.item_chat_user, parent, false), true);
        } else {
            return new Holder(inflater.inflate(R.layout.item_chat_claude, parent, false), false);
        }
    }

    @Override
    public void onBindViewHolder(@NonNull Holder holder, int position) {
        ChatMessage msg = messages.get(position);
        String text = msg.text != null ? msg.text.trim() : "";

        holder.timeView.setText(timeFmt.format(new Date(msg.timestamp)));

        if (holder.isUser) {
            // User messages: plain text
            holder.textView.setText(text);
        } else {
            // Claude messages: render Markdown or plain text based on toggle
            if (msg.showRendered) {
                try {
                    if (!markwonInited) {
                        markwon = Markwon.builder(holder.textView.getContext())
                                .usePlugin(CorePlugin.create())
                                .usePlugin(TablePlugin.create(holder.textView.getContext()))
                                .build();
                        markwonInited = true;
                    }
                    markwon.setMarkdown(holder.textView, text);
                    holder.textView.setMovementMethod(LinkMovementMethod.getInstance());
                } catch (Exception e) {
                    // Markdown rendering failed — fall back to plain text
                    msg.showRendered = false;
                    holder.textView.setText(text);
                    holder.textView.setMovementMethod(null);
                    e.printStackTrace();
                }
            } else {
                holder.textView.setText(text);
                holder.textView.setMovementMethod(null);
            }

            // Toggle button: shows what clicking it will switch TO
            if (holder.toggleBtn != null) {
                holder.toggleBtn.setText(msg.showRendered ? "原文" : "渲染");
                holder.toggleBtn.setVisibility(View.VISIBLE);
                holder.toggleBtn.setOnClickListener(v -> {
                    msg.showRendered = !msg.showRendered;
                    notifyItemChanged(position);
                });
            }
        }
    }

    @Override
    public int getItemCount() {
        return messages.size();
    }

    static class Holder extends RecyclerView.ViewHolder {
        TextView textView;
        TextView timeView;
        TextView toggleBtn;
        boolean isUser;

        Holder(View itemView, boolean isUser) {
            super(itemView);
            this.isUser = isUser;
            textView = itemView.findViewById(R.id.chat_text);
            timeView = itemView.findViewById(R.id.chat_time);
            toggleBtn = itemView.findViewById(R.id.btn_toggle_render);
        }
    }
}
