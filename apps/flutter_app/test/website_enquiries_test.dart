import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trustkeyper/src/features/admin/data/website_enquiry_gateway.dart';
import 'package:trustkeyper/src/features/admin/presentation/website_enquiries_screen.dart';

class _Gateway implements WebsiteEnquiryGateway {
  bool fail = false;
  final updates = <List<String>>[];

  @override
  Future<Map<String, dynamic>> list({String? cursor}) async {
    if (fail) throw StateError('Local fixture error');
    return {
      'enquiries': [
        {
          'id': 'a' * 64,
          'firstName': 'Local',
          'lastName': 'Owner',
          'email': 'owner@example.test',
          'phone': '',
          'role': 'property_owner',
          'selectedOptions': ['Rent collection', 'Property tax'],
          'message': 'Needs property management',
          'createdAt': 1793600000000,
          'status': 'new',
          'note': '',
          'deliveryStatus': 'delivered',
        },
        {
          'id': 'b' * 64,
          'firstName': 'Local',
          'lastName': 'Builder',
          'email': 'builder@example.test',
          'phone': '',
          'role': 'builder',
          'message': 'Construction updates',
          'createdAt': 1793600000001,
          'status': 'closed',
          'note': 'Already handled',
          'deliveryStatus': 'unconfirmed',
        },
      ],
      'nextCursor': null,
    };
  }

  @override
  Future<void> update(String id, String status, String note) async {
    if (fail) throw StateError('Local fixture error');
    updates.add([id, status, note]);
  }
}

Future<void> _open(WidgetTester tester, _Gateway gateway) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: WebsiteEnquiriesScreen(gateway: gateway),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('admin inbox shows enquiries, filters and searches', (
    tester,
  ) async {
    final gateway = _Gateway();
    await _open(tester, gateway);
    expect(find.text('Local Owner'), findsOneWidget);
    expect(find.text('Local Builder'), findsOneWidget);
    expect(find.textContaining('amanmaheshwari900@gmail.com'), findsOneWidget);
    await tester.tap(find.widgetWithText(ChoiceChip, 'New'));
    await tester.pumpAndSettle();
    expect(find.text('Local Owner'), findsOneWidget);
    expect(find.text('Local Builder'), findsNothing);
    await tester.enterText(find.byType(TextField), 'not-present');
    await tester.pumpAndSettle();
    expect(find.text('No enquiries match this view.'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('failed load is actionable instead of showing an empty inbox', (
    tester,
  ) async {
    final gateway = _Gateway()..fail = true;
    await _open(tester, gateway);
    expect(find.textContaining('Could not load enquiries'), findsOneWidget);
    gateway.fail = false;
    await tester.tap(find.text('Refresh'));
    await tester.pumpAndSettle();
    expect(find.text('Local Owner'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'submitted options are visible and searchable as separate labels',
    (tester) async {
      await _open(tester, _Gateway());
      expect(find.text('Selected options'), findsOneWidget);
      expect(find.widgetWithText(Chip, 'Rent collection'), findsOneWidget);
      expect(find.widgetWithText(Chip, 'Property tax'), findsOneWidget);
      expect(find.text('Construction updates'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'property tax');
      await tester.pumpAndSettle();
      expect(find.text('Local Owner'), findsOneWidget);
      expect(find.text('Local Builder'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('manage saves status and note through the trusted gateway', (
    tester,
  ) async {
    final gateway = _Gateway();
    await _open(tester, gateway);
    await tester.ensureVisible(find.text('Manage').first);
    await tester.tap(find.text('Manage').first);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Internal note'),
      'Called owner',
    );
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(gateway.updates.single, ['a' * 64, 'new', 'Called owner']);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('inbox fits a phone viewport', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await _open(tester, _Gateway());
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
