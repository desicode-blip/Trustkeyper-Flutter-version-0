import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/website_enquiry_gateway.dart';

class WebsiteEnquiriesScreen extends StatefulWidget {
  const WebsiteEnquiriesScreen({super.key, this.gateway});

  final WebsiteEnquiryGateway? gateway;

  @override
  State<WebsiteEnquiriesScreen> createState() => _WebsiteEnquiriesScreenState();
}

class _WebsiteEnquiriesScreenState extends State<WebsiteEnquiriesScreen> {
  late final WebsiteEnquiryGateway _gateway =
      widget.gateway ?? FirebaseWebsiteEnquiryGateway();
  final List<String?> _pages = [null];
  List<Map<String, dynamic>> _records = [];
  String? _nextCursor;
  String? _error;
  String _filter = 'all';
  String _query = '';
  bool _loading = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (_pages.length == 1 && !_loading) _load();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await _gateway.list(cursor: _pages.last);
      if (!mounted) return;
      setState(() {
        _records = (result['enquiries'] as List? ?? [])
            .map((record) => Map<String, dynamic>.from(record as Map))
            .toList();
        _nextCursor = result['nextCursor'] as String?;
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Could not load enquiries. Check your admin session and retry.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _edit(Map<String, dynamic> record) async {
    var note = record['note'] as String? ?? '';
    var status = record['status'] as String? ?? 'new';
    var saving = false;
    String? failure;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, updateDialog) => AlertDialog(
          title: const Text('Manage enquiry'),
          content: SizedBox(
            width: 450,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: status,
                  decoration: const InputDecoration(labelText: 'Status'),
                  items: const [
                    DropdownMenuItem(value: 'new', child: Text('New')),
                    DropdownMenuItem(
                      value: 'contacted',
                      child: Text('Contacted'),
                    ),
                    DropdownMenuItem(value: 'closed', child: Text('Closed')),
                  ],
                  onChanged: saving
                      ? null
                      : (value) => updateDialog(() => status = value!),
                ),
                const SizedBox(height: 16),
                TextFormField(
                  initialValue: note,
                  onChanged: (value) => note = value,
                  enabled: !saving,
                  maxLines: 4,
                  maxLength: 2000,
                  decoration: const InputDecoration(
                    labelText: 'Internal note',
                    border: OutlineInputBorder(),
                  ),
                ),
                if (failure != null)
                  Text(
                    failure!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.pop(dialogContext),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: saving
                  ? null
                  : () async {
                      updateDialog(() {
                        saving = true;
                        failure = null;
                      });
                      try {
                        await _gateway.update(
                          record['id'] as String,
                          status,
                          note.trim(),
                        );
                        if (dialogContext.mounted) Navigator.pop(dialogContext);
                        await _load();
                      } catch (_) {
                        if (dialogContext.mounted) {
                          updateDialog(() {
                            saving = false;
                            failure = 'Could not save. Please retry.';
                          });
                        }
                      }
                    },
              child: Text(saving ? 'Saving…' : 'Save'),
            ),
          ],
        ),
      ),
    );
  }

  String _date(dynamic value) {
    final date = value is num
        ? DateTime.fromMillisecondsSinceEpoch(value.toInt())
        : DateTime.tryParse('$value');
    return date == null
        ? 'Date unavailable'
        : DateFormat('d MMM yyyy, h:mm a').format(date.toLocal());
  }

  Future<void> _email(String address) async {
    final opened = await launchUrl(Uri(scheme: 'mailto', path: address));
    if (!opened && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('No email app is available. Use Copy contact instead.'),
        ),
      );
    }
  }

  Iterable<String> _selectedOptions(Map<String, dynamic> record) {
    final options = record['selectedOptions'];
    return options is List ? options.whereType<String>() : const <String>[];
  }

  Widget _optionSummary(Map<String, dynamic> record) {
    final options = _selectedOptions(record);
    if (options.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Selected options',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [for (final option in options) Chip(label: Text(option))],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final records = _records
        .where(
          (record) =>
              (_filter == 'all' || record['status'] == _filter) &&
              [
                record['firstName'],
                record['lastName'],
                record['email'],
                record['phone'],
                record['message'],
                ..._selectedOptions(record),
              ].join(' ').toLowerCase().contains(_query.toLowerCase()),
        )
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Wrap(
          spacing: 16,
          runSpacing: 12,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              'Website enquiries',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            OutlinedButton.icon(
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh),
              label: const Text('Refresh'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        const Text(
          'New enquiries appear here. Notifications go to amanmaheshwari900@gmail.com. The first page refreshes every 30 seconds.',
        ),
        const SizedBox(height: 20),
        TextField(
          decoration: const InputDecoration(
            labelText: 'Search this page',
            prefixIcon: Icon(Icons.search),
            border: OutlineInputBorder(),
          ),
          onChanged: (value) => setState(() => _query = value),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          children: [
            for (final status in ['all', 'new', 'contacted', 'closed'])
              ChoiceChip(
                label: Text(status[0].toUpperCase() + status.substring(1)),
                selected: _filter == status,
                onSelected: (_) => setState(() => _filter = status),
              ),
          ],
        ),
        if (_loading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 20),
            child: LinearProgressIndicator(),
          ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Text(
              _error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        if (!_loading && _error == null && records.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 32),
            child: Text('No enquiries match this view.'),
          ),
        for (final record in records)
          Card(
            margin: const EdgeInsets.symmetric(vertical: 8),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${record['firstName']} ${record['lastName']}'.trim(),
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 12,
                    runSpacing: 6,
                    children: [
                      Text('Status: ${record['status']}'),
                      Text(
                        'Role: ${record['role'] == 'broker' ? 'Property agent' : record['role']}',
                      ),
                      Text(_date(record['createdAt'])),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text('Email: ${record['email']}'),
                  if ('${record['phone'] ?? ''}'.isNotEmpty)
                    Text('Phone: ${record['phone']}'),
                  Text('Notification: ${record['deliveryStatus']}'),
                  const Divider(height: 28),
                  _optionSummary(record),
                  Text('${record['message']}'),
                  if ('${record['note'] ?? ''}'.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Text('Internal note: ${record['note']}'),
                    ),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 12,
                    runSpacing: 8,
                    children: [
                      FilledButton.icon(
                        onPressed: () => _edit(record),
                        icon: const Icon(Icons.edit_outlined),
                        label: const Text('Manage'),
                      ),
                      if ('${record['email'] ?? ''}'.isNotEmpty)
                        OutlinedButton.icon(
                          onPressed: () => _email(record['email'] as String),
                          icon: const Icon(Icons.email_outlined),
                          label: const Text('Email'),
                        ),
                      TextButton.icon(
                        onPressed: () => Clipboard.setData(
                          ClipboardData(
                            text: '${record['email']} ${record['phone']}'
                                .trim(),
                          ),
                        ),
                        icon: const Icon(Icons.copy),
                        label: const Text('Copy contact'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 12,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            OutlinedButton(
              onPressed: _loading || _pages.length == 1
                  ? null
                  : () {
                      _pages.removeLast();
                      _load();
                    },
              child: const Text('Previous'),
            ),
            Text('Page ${_pages.length}'),
            OutlinedButton(
              onPressed: _loading || _nextCursor == null
                  ? null
                  : () {
                      _pages.add(_nextCursor);
                      _load();
                    },
              child: const Text('Next'),
            ),
          ],
        ),
      ],
    );
  }
}
