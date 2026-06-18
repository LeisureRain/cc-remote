package com.romp.ccremote.ui;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.romp.ccremote.R;
import com.romp.ccremote.model.SessionInfo;

import java.util.ArrayList;
import java.util.List;

/**
 * RecyclerView adapter for displaying Claude Code sessions
 */
public class SessionAdapter extends RecyclerView.Adapter<SessionAdapter.ViewHolder> {

    private List<SessionInfo> sessions = new ArrayList<>();
    private OnSessionClickListener listener;

    public interface OnSessionClickListener {
        void onSessionClick(SessionInfo session);
    }

    public SessionAdapter(OnSessionClickListener listener) {
        this.listener = listener;
    }

    public void setSessions(List<SessionInfo> sessions) {
        this.sessions = sessions != null ? sessions : new ArrayList<>();
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_session, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull ViewHolder holder, int position) {
        SessionInfo session = sessions.get(position);
        holder.bind(session);
        holder.itemView.setOnClickListener(v -> {
            if (listener != null) {
                listener.onSessionClick(session);
            }
        });
    }

    @Override
    public int getItemCount() {
        return sessions.size();
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView titleView;
        TextView statusView;
        TextView clientsView;
        TextView dirView;
        View statusDot;

        ViewHolder(View itemView) {
            super(itemView);
            titleView = itemView.findViewById(R.id.session_title);
            statusView = itemView.findViewById(R.id.session_status);
            clientsView = itemView.findViewById(R.id.session_clients);
            dirView = itemView.findViewById(R.id.session_dir);
            statusDot = itemView.findViewById(R.id.session_status_dot);
        }

        void bind(SessionInfo session) {
            titleView.setText(session.getDisplayTitle());
            statusView.setText(session.getDisplayStatus());
            clientsView.setText(session.clientCount + " client" + (session.clientCount != 1 ? "s" : ""));
            dirView.setText(session.directory);

            if (session.isRunning()) {
                statusDot.setBackgroundResource(R.drawable.status_dot_green);
            } else {
                statusDot.setBackgroundResource(R.drawable.status_dot_red);
            }
        }
    }
}
