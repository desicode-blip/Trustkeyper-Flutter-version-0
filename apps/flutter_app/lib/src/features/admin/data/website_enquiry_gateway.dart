import 'package:cloud_functions/cloud_functions.dart';

abstract interface class WebsiteEnquiryGateway {
  Future<Map<String, dynamic>> list({String? cursor});

  Future<void> update(String id, String status, String note);
}

class FirebaseWebsiteEnquiryGateway implements WebsiteEnquiryGateway {
  FirebaseWebsiteEnquiryGateway({FirebaseFunctions? functions})
    : _functions =
          functions ?? FirebaseFunctions.instanceFor(region: 'asia-south1');

  final FirebaseFunctions _functions;

  @override
  Future<Map<String, dynamic>> list({String? cursor}) async {
    final result = await _functions
        .httpsCallable('readWebsiteEnquiries')
        .call<Map<String, dynamic>>({'cursor': ?cursor});
    return result.data;
  }

  @override
  Future<void> update(String id, String status, String note) async {
    await _functions
        .httpsCallable('updateWebsiteEnquiry')
        .call<Map<String, dynamic>>({'id': id, 'status': status, 'note': note});
  }
}
